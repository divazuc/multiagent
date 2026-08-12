// server/test/trial-reminders-manual.test.js
//
// The owner-in-the-loop manual flow layered on top of lib/trial-reminders.js:
// previewTrialReminders / sendTrialReminders (the studio leads-board screen),
// the /studio/rpc wiring (lib/studio.js), business scoping, and the
// /cron/trial-reminders auto-send guard flag (manual mode is now default).
// The automatic run itself (runTrialReminders) is unchanged and stays
// covered by test/trial-reminders.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:0';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const tr = await import('../lib/trial-reminders.js');
const { previewTrialReminders, sendTrialReminders, cronAutoSendEnabled } = tr;
const { runStudioOp } = await import('../lib/studio.js');

const BIZ = 'biz-ck';
const TODAY = '2026-08-12';
// The real configured test-redirect number for קרוספיט קידס (Diva, pilot phase) —
// same number used elsewhere in this codebase (e.g. OWNER_ESCALATION_PHONE).
const TEST_NUMBER = '972528250088';

const lead = (over = {}) => ({
  id: over.id ?? 'lead-1', business_id: BIZ, phone: over.phone ?? '972501234567',
  display_name: null, status: 'trial_signed_up', source: 'form',
  payload: { child_name: 'יובל', trial_time: '16:00', trial_date: TODAY },
  ...over,
});

// Single-business fake — enough for previewTrialReminders/sendTrialReminders,
// which (unlike runTrialReminders) act on one business at a time.
function makeFakeDb({ module = { enabled: true, settings: {} }, leads = [] } = {}) {
  const updates = [];
  return {
    updates,
    async getLeadsModule() { return module; },
    async listLeads() { return leads.map(l => ({ ...l })); },
    async updateLead(id, patch) { updates.push({ id, patch }); },
  };
}

// Multi-business fake, filtering by the businessId argument like the real
// Supabase-backed db does — for the cross-business leakage test.
function makeMultiBizFakeDb({ modules = {}, allLeads = [] } = {}) {
  const updates = [];
  return {
    updates,
    async getLeadsModule(businessId) { return modules[businessId] ?? null; },
    async listLeads(businessId) { return allLeads.filter(l => l.business_id === businessId).map(l => ({ ...l })); },
    async updateLead(id, patch) { updates.push({ id, patch }); },
  };
}

test.afterEach(() => {
  tr._setDbForTest(null);
  tr._setSenderForTest(null);
  tr._setTemplateSenderForTest(null);
  delete process.env.TRIAL_REMINDERS_CRON_AUTOSEND;
  delete process.env.WHATSAPP_TRIAL_REMINDER_TEMPLATE;
});

// ── previewTrialReminders: filtering ─────────────────────────────────────────

test('previewTrialReminders: only this date, never a not_relevant lead, sorted by trial_time', async () => {
  tr._setDbForTest(makeFakeDb({
    leads: [
      lead({ id: 'l-later', phone: '972502222220', payload: { trial_date: TODAY, trial_time: '17:30' } }),
      lead({ id: 'l-today', phone: '972501234567', payload: { trial_date: TODAY, trial_time: '16:00' } }),
      lead({ id: 'l-other-date', phone: '972502222221', payload: { trial_date: '2026-08-13' } }),
      lead({ id: 'l-not-relevant', phone: '972502222222', status: 'not_relevant' }),
    ],
  }));
  const out = await previewTrialReminders(BIZ, TODAY);
  assert.equal(out.date, TODAY);
  assert.deepEqual(out.leads.map(l => l.id), ['l-today', 'l-later']); // sorted by trial_time
});

test('previewTrialReminders: throws when the leads module is not enabled for this business', async () => {
  tr._setDbForTest(makeFakeDb({ module: { enabled: false, settings: {} } }));
  await assert.rejects(() => previewTrialReminders(BIZ, TODAY), /not enabled/i);
});

test('previewTrialReminders: surfaces the safety mode + test recipient so the studio can warn before sending', async () => {
  tr._setDbForTest(makeFakeDb({
    module: { enabled: true, settings: { reminders_enabled: true, reminder_test_recipient: TEST_NUMBER } },
    leads: [lead()],
  }));
  const out = await previewTrialReminders(BIZ, TODAY);
  assert.equal(out.mode, 'test_redirect');
  assert.equal(out.test_recipient, TEST_NUMBER);
});

// ── already-sent-TODAY badge/default-unchecked data contract ────────────────

test('previewTrialReminders: already_sent is scoped to THIS date, carries status + timestamp for the badge', async () => {
  tr._setDbForTest(makeFakeDb({
    leads: [
      lead({ id: 'l-fresh' }),
      lead({
        id: 'l-reminded', phone: '972502222224',
        payload: { trial_date: TODAY, reminder_sent_on: TODAY, reminder_status: 'sent', reminder_sent_at: '2026-08-12T06:05:00.000Z' },
      }),
      // reminded YESTERDAY for a trial dated TODAY — not "already sent" for today's run
      lead({ id: 'l-reminded-yesterday', phone: '972502222225', payload: { trial_date: TODAY, reminder_sent_on: '2026-08-11', reminder_status: 'sent' } }),
    ],
  }));
  const out = await previewTrialReminders(BIZ, TODAY);
  const byId = Object.fromEntries(out.leads.map(l => [l.id, l]));
  assert.equal(byId['l-fresh'].already_sent, false);
  assert.equal(byId['l-fresh'].reminder_sent_at, null);
  assert.equal(byId['l-reminded'].already_sent, true);
  assert.equal(byId['l-reminded'].reminder_status, 'sent');
  assert.equal(byId['l-reminded'].reminder_sent_at, '2026-08-12T06:05:00.000Z');
  assert.equal(byId['l-reminded-yesterday'].already_sent, false);
});

test('LeadsManager defaults already-sent leads to UNCHECKED, everyone else CHECKED (reads already_sent from the preview)', () => {
  const src = fs.readFileSync(new URL('../../wa-studio/src/demo/LeadsManager.jsx', import.meta.url), 'utf8');
  assert.ok(src.includes('filter(l => !l.already_sent)'), 'the checked set excludes already-sent leads by default');
});

// ── sendTrialReminders: only the checked ids, same 3-mode safety ────────────

test('sendTrialReminders: sends ONLY the requested lead_ids, ignores every other lead on the board', async () => {
  const db = makeFakeDb({
    module: { enabled: true, settings: { reminders_enabled: true } },
    leads: [lead({ id: 'l-checked' }), lead({ id: 'l-unchecked', phone: '972502222223' })],
  });
  tr._setDbForTest(db);
  const sends = [];
  tr._setSenderForTest(async (msg) => { sends.push(msg); return { messages: [{ id: 'wamid.1' }] }; });

  const out = await sendTrialReminders(BIZ, { dateKey: TODAY, leadIds: ['l-checked'] });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].to, '972501234567');
  assert.equal(out.requested, 1);
  assert.equal(out.sent_count, 1);
  assert.deepEqual(out.results.map(r => r.id), ['l-checked']);
});

test('sendTrialReminders: dry-run — nothing sent, nothing recorded', async () => {
  const db = makeFakeDb({ module: { enabled: true, settings: {} }, leads: [lead({ id: 'l-1' })] }); // reminders_enabled absent
  tr._setDbForTest(db);
  const sends = [];
  tr._setSenderForTest(async (msg) => { sends.push(msg); return { messages: [{ id: 'x' }] }; });

  const out = await sendTrialReminders(BIZ, { dateKey: TODAY, leadIds: ['l-1'] });
  assert.equal(sends.length, 0);
  assert.equal(db.updates.length, 0);
  assert.equal(out.mode, 'dry_run');
  assert.equal(out.results[0].status, 'dry_run');
});

test('sendTrialReminders: test-redirect — every send prefixed to the test number, board left untouched', async () => {
  process.env.WHATSAPP_TRIAL_REMINDER_TEMPLATE = 'trial_reminder_he';
  const db = makeFakeDb({
    module: { enabled: true, settings: { reminders_enabled: true, reminder_test_recipient: TEST_NUMBER } },
    leads: [lead({ id: 'l-1' })],
  });
  tr._setDbForTest(db);
  const sends = [];
  tr._setSenderForTest(async (msg) => { sends.push(msg); return { messages: [{ id: 'wamid.1' }] }; });

  const out = await sendTrialReminders(BIZ, { dateKey: TODAY, leadIds: ['l-1'] });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].to, TEST_NUMBER);
  assert.ok(sends[0].text.startsWith('[בדיקה — היה נשלח אל 0501234567]\n'));
  assert.equal(db.updates.length, 0); // a rehearsal leaves the board untouched
  assert.equal(out.mode, 'test_redirect');
  assert.equal(out.results[0].redirected_to, TEST_NUMBER);
});

test('sendTrialReminders: live — records reminder_sent_on/status AND a real sent_at timestamp', async () => {
  const db = makeFakeDb({ module: { enabled: true, settings: { reminders_enabled: true } }, leads: [lead({ id: 'l-1' })] });
  tr._setDbForTest(db);
  tr._setSenderForTest(async () => ({ messages: [{ id: 'wamid.1' }] }));

  const before = Date.now();
  const out = await sendTrialReminders(BIZ, { dateKey: TODAY, leadIds: ['l-1'] });
  assert.equal(out.mode, 'live');
  assert.equal(db.updates.length, 1);
  const patch = db.updates[0].patch.payload;
  assert.equal(patch.reminder_sent_on, TODAY);
  assert.equal(patch.reminder_status, 'sent');
  assert.ok(patch.reminder_sent_at && new Date(patch.reminder_sent_at).getTime() >= before);
});

test('sendTrialReminders: a checked id no longer matching this date (or now not_relevant) is skipped, not sent to', async () => {
  const db = makeFakeDb({
    module: { enabled: true, settings: { reminders_enabled: true } },
    leads: [
      lead({ id: 'l-stale-date', payload: { trial_date: '2026-08-13' } }),
      lead({ id: 'l-now-not-relevant', phone: '972502222226', status: 'not_relevant' }),
    ],
  });
  tr._setDbForTest(db);
  const sends = [];
  tr._setSenderForTest(async (msg) => { sends.push(msg); return { messages: [{ id: 'x' }] }; });

  const out = await sendTrialReminders(BIZ, { dateKey: TODAY, leadIds: ['l-stale-date', 'l-now-not-relevant'] });
  assert.equal(sends.length, 0);
  assert.equal(out.results.length, 0);
  assert.equal(out.skipped, 2);
});

test('sendTrialReminders: throws without lead_ids, and without a business id', async () => {
  tr._setDbForTest(makeFakeDb());
  await assert.rejects(() => sendTrialReminders(BIZ, { dateKey: TODAY, leadIds: [] }), /lead_ids/i);
  await assert.rejects(() => sendTrialReminders(null, { dateKey: TODAY, leadIds: ['x'] }), /business/i);
});

// ── Business scoping (no cross-business leakage) ─────────────────────────────

test('business scoping: a lead_id belonging to another business can never be reached', async () => {
  const db = makeMultiBizFakeDb({
    modules: {
      'biz-a': { enabled: true, settings: { reminders_enabled: true } },
      'biz-b': { enabled: true, settings: { reminders_enabled: true } },
    },
    allLeads: [
      { ...lead({ id: 'l-a' }), business_id: 'biz-a' },
      { ...lead({ id: 'l-b', phone: '972502222229' }), business_id: 'biz-b' },
    ],
  });
  tr._setDbForTest(db);
  const sends = [];
  tr._setSenderForTest(async (msg) => { sends.push(msg); return { messages: [{ id: 'x' }] }; });

  // business A asked to send to business B's lead id
  const out = await sendTrialReminders('biz-a', { dateKey: TODAY, leadIds: ['l-b'] });
  assert.equal(sends.length, 0);
  assert.equal(out.results.length, 0);
  assert.equal(out.skipped, 1);

  // and the preview never shows it either
  const preview = await previewTrialReminders('biz-a', TODAY);
  assert.deepEqual(preview.leads.map(l => l.id), ['l-a']);
});

// ── /studio/rpc wiring (the studio's existing authenticated surface) ────────

test('studio/rpc: previewTrialReminders/sendTrialReminders dispatch business-scoped, same pattern as listLeads', async () => {
  tr._setDbForTest(makeFakeDb({
    module: { enabled: true, settings: { reminders_enabled: true } },
    leads: [lead({ id: 'l-1' })],
  }));
  const preview = await runStudioOp('previewTrialReminders', [BIZ, TODAY]);
  assert.deepEqual(preview.leads.map(l => l.id), ['l-1']);

  tr._setSenderForTest(async () => ({ messages: [{ id: 'wamid.1' }] }));
  const sent = await runStudioOp('sendTrialReminders', [BIZ, { date: TODAY, lead_ids: ['l-1'] }]);
  assert.equal(sent.requested, 1);
  assert.equal(sent.sent_count, 1);
});

// ── Cron endpoint: manual mode is now the default ────────────────────────────

test('cronAutoSendEnabled: OFF by default, ON only when the env flag is exactly "true"', () => {
  assert.equal(cronAutoSendEnabled({}), false);
  assert.equal(cronAutoSendEnabled({ TRIAL_REMINDERS_CRON_AUTOSEND: 'false' }), false);
  assert.equal(cronAutoSendEnabled({ TRIAL_REMINDERS_CRON_AUTOSEND: '1' }), false);
  assert.equal(cronAutoSendEnabled({ TRIAL_REMINDERS_CRON_AUTOSEND: 'true' }), true);
});

test('index.js: /cron/trial-reminders auto-send is guarded by the flag, with a manual force override', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const at = src.indexOf("app.post('/cron/trial-reminders'");
  assert.ok(at !== -1);
  const body = src.slice(at, at + 900);
  assert.ok(body.includes('cronAutoSendEnabled'), 'the guard flag is checked');
  assert.ok(body.includes('force'), 'a manual/fallback override exists');
  assert.ok(body.includes('skipped'), 'a guarded hit reports skipped, not success');
  assert.ok(body.includes('runTrialReminders'), 'the real runner still exists behind the guard');
});
