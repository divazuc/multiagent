// lib/leads.js — the ניהול לידים board's core rules: upsert-on-inbound, the
// no-downgrade ladder, manual edits with history, fail-soft everywhere, and
// the CSV that replaces the client's Google Sheet.
import test from 'node:test';
import assert from 'node:assert/strict';

const leads = await import('../lib/leads.js');
const {
  LEAD_STATUSES, nextAutoStatus,
  recordInboundMessage, recordOwnerEcho, recordTrialSignup,
  listLeadsForApi, applyLeadUpdate, filterLeads, leadCounts, leadsToCsv,
} = leads;

const BIZ = 'biz-ck';
const PHONE = '972501234567';

function makeFakeDb({ enabled = true, rows = [], failLeads = false } = {}) {
  let seq = 0;
  const store = rows.map(r => ({ ...r }));
  const boom = () => { throw new Error('relation "leads" does not exist'); };
  return {
    store,
    async isEnabled() { return enabled; },
    async getLead(businessId, phone) {
      if (failLeads) boom();
      return store.find(l => l.business_id === businessId && l.phone === phone) ?? null;
    },
    async getLeadById(businessId, id) {
      if (failLeads) boom();
      return store.find(l => l.business_id === businessId && l.id === id) ?? null;
    },
    async insertLead(row) {
      if (failLeads) boom();
      const withId = { id: `lead-${++seq}`, ...row };
      store.push(withId);
      return withId;
    },
    async updateLead(id, patch) {
      if (failLeads) boom();
      const i = store.findIndex(l => l.id === id);
      if (i === -1) throw new Error('no such lead');
      store[i] = { ...store[i], ...patch };
    },
    async listLeads(businessId) {
      if (failLeads) boom();
      return store
        .filter(l => l.business_id === businessId)
        .sort((a, b) => new Date(b.last_contact_at ?? 0) - new Date(a.last_contact_at ?? 0));
    },
  };
}

const seededLead = (over = {}) => ({
  id: 'lead-seed', business_id: BIZ, phone: PHONE, display_name: null,
  status: 'new', source: 'whatsapp',
  first_contact_at: '2026-08-10T08:00:00.000Z', last_contact_at: '2026-08-10T08:00:00.000Z',
  last_direction: 'in', payload: {}, notes: null, status_history: [], ...over,
});

test.afterEach(() => leads._setDbForTest(null));

// ── Status model ─────────────────────────────────────────────────────────────

test('the status catalog carries the exact Hebrew labels, centralized', () => {
  assert.deepEqual(LEAD_STATUSES.map(s => [s.key, s.label]), [
    ['new', 'חדש'],
    ['contacted', 'נוצר קשר'],
    ['trial_signed_up', 'נרשם לניסיון'],
    ['attended', 'הגיע לאימון'],
    ['joined', 'הצטרף'],
    ['not_relevant', 'לא רלוונטי'],
  ]);
});

test('nextAutoStatus advances, never downgrades, never touches human marks', () => {
  assert.equal(nextAutoStatus(null, 'new'), 'new');
  assert.equal(nextAutoStatus('new', 'contacted'), 'contacted');
  assert.equal(nextAutoStatus('contacted', 'trial_signed_up'), 'trial_signed_up');
  // no downgrade — a further-along lead stays put
  assert.equal(nextAutoStatus('trial_signed_up', 'contacted'), null);
  assert.equal(nextAutoStatus('attended', 'trial_signed_up'), null);
  assert.equal(nextAutoStatus('joined', 'contacted'), null);
  assert.equal(nextAutoStatus('contacted', 'contacted'), null);
  // human marks (off the auto ladder) are never overwritten…
  assert.equal(nextAutoStatus('not_relevant', 'contacted'), null);
  assert.equal(nextAutoStatus('vip-manual-mark', 'contacted'), null);
  // …and never written by automation
  assert.equal(nextAutoStatus('new', 'not_relevant'), null);
  assert.equal(nextAutoStatus('new', 'bogus'), null);
});

// ── Inbound upsert ───────────────────────────────────────────────────────────

test('first inbound message creates the lead as new, with contact bookkeeping', async () => {
  const db = makeFakeDb();
  leads._setDbForTest(db);
  const now = new Date('2026-08-12T10:00:00.000Z');
  const out = await recordInboundMessage({ businessId: BIZ, phone: PHONE, profileName: 'שירה לוי', now });
  assert.deepEqual(out, { recorded: true, created: true });
  const l = db.store[0];
  assert.equal(l.status, 'new');
  assert.equal(l.display_name, 'שירה לוי');
  assert.equal(l.first_contact_at, now.toISOString());
  assert.equal(l.last_contact_at, now.toISOString());
  assert.equal(l.last_direction, 'in');
  assert.equal(l.source, 'whatsapp');
  assert.deepEqual(l.status_history, []);
});

test('every further message refreshes last_contact, keeps status and first_contact', async () => {
  const db = makeFakeDb({ rows: [seededLead({ status: 'trial_signed_up', last_direction: 'out' })] });
  leads._setDbForTest(db);
  const now = new Date('2026-08-12T11:00:00.000Z');
  const out = await recordInboundMessage({ businessId: BIZ, phone: PHONE, now });
  assert.deepEqual(out, { recorded: true, created: false });
  const l = db.store[0];
  assert.equal(l.status, 'trial_signed_up'); // an inbound message never moves the ladder down
  assert.equal(l.first_contact_at, '2026-08-10T08:00:00.000Z');
  assert.equal(l.last_contact_at, now.toISOString());
  assert.equal(l.last_direction, 'in');
});

test('display_name backfills once, never overwrites what is already there', async () => {
  const db = makeFakeDb({ rows: [seededLead({ display_name: 'שם קיים' })] });
  leads._setDbForTest(db);
  await recordInboundMessage({ businessId: BIZ, phone: PHONE, profileName: 'שם חדש' });
  assert.equal(db.store[0].display_name, 'שם קיים');

  const db2 = makeFakeDb({ rows: [seededLead()] });
  leads._setDbForTest(db2);
  await recordInboundMessage({ businessId: BIZ, phone: PHONE, profileName: 'שם חדש' });
  assert.equal(db2.store[0].display_name, 'שם חדש');
});

test('module disabled → nothing recorded, store untouched', async () => {
  const db = makeFakeDb({ enabled: false });
  leads._setDbForTest(db);
  const out = await recordInboundMessage({ businessId: BIZ, phone: PHONE });
  assert.deepEqual(out, { recorded: false, reason: 'module_disabled' });
  assert.equal(db.store.length, 0);
});

test('table missing (DDL not applied) → fail soft, never throw', async () => {
  leads._setDbForTest(makeFakeDb({ failLeads: true }));
  const out = await recordInboundMessage({ businessId: BIZ, phone: PHONE });
  assert.deepEqual(out, { recorded: false, reason: 'error' });
});

test('synthetic studio session ids never become board rows', async () => {
  const db = makeFakeDb();
  leads._setDbForTest(db);
  for (const junk of ['studio-session-1', 'demo_ABC', '', null]) {
    const out = await recordInboundMessage({ businessId: BIZ, phone: junk });
    assert.equal(out.recorded, false);
  }
  assert.equal(db.store.length, 0);
});

// ── Owner echo → contacted ───────────────────────────────────────────────────

test('owner echo advances new → contacted with an auto history entry', async () => {
  const db = makeFakeDb({ rows: [seededLead()] });
  leads._setDbForTest(db);
  const now = new Date('2026-08-12T12:00:00.000Z');
  const out = await recordOwnerEcho({ businessId: BIZ, phone: PHONE, now });
  assert.equal(out.recorded, true);
  assert.equal(out.advanced, 'contacted');
  const l = db.store[0];
  assert.equal(l.status, 'contacted');
  assert.equal(l.last_direction, 'out');
  assert.equal(l.last_contact_at, now.toISOString());
  assert.deepEqual(l.status_history, [{ from: 'new', to: 'contacted', at: now.toISOString(), by: 'auto' }]);
});

test('owner echo never downgrades a lead already past contacted', async () => {
  const db = makeFakeDb({ rows: [seededLead({ status: 'trial_signed_up' })] });
  leads._setDbForTest(db);
  const out = await recordOwnerEcho({ businessId: BIZ, phone: PHONE });
  assert.equal(out.advanced, null);
  assert.equal(db.store[0].status, 'trial_signed_up');
  assert.deepEqual(db.store[0].status_history, []); // no phantom transition
  assert.equal(db.store[0].last_direction, 'out');  // but the bookkeeping still updates
});

test('owner echo with no lead row yet creates it as contacted (owner wrote first)', async () => {
  const db = makeFakeDb();
  leads._setDbForTest(db);
  await recordOwnerEcho({ businessId: BIZ, phone: PHONE });
  const l = db.store[0];
  assert.equal(l.status, 'contacted');
  assert.equal(l.last_direction, 'out');
  assert.equal(l.status_history.length, 1);
  assert.equal(l.status_history[0].by, 'auto');
});

test('owner echo respects the module gate and fails soft', async () => {
  const db = makeFakeDb({ enabled: false });
  leads._setDbForTest(db);
  assert.equal((await recordOwnerEcho({ businessId: BIZ, phone: PHONE })).recorded, false);
  assert.equal(db.store.length, 0);

  leads._setDbForTest(makeFakeDb({ failLeads: true }));
  const out = await recordOwnerEcho({ businessId: BIZ, phone: PHONE });
  assert.deepEqual(out, { recorded: false, reason: 'error' });
});

// ── Trial signup → trial_signed_up + payload merge ───────────────────────────

test('trial signup advances the lead and merges the structured fields', async () => {
  const db = makeFakeDb({ rows: [seededLead({ status: 'contacted', payload: { note: 'קיים' } })] });
  leads._setDbForTest(db);
  const out = await recordTrialSignup({
    businessId: BIZ, phone: PHONE,
    fields: { parent_name: 'שירה לוי', child_name: 'יובל', child_age: '8', preferred_day: 'רביעי' },
  });
  assert.equal(out.advanced, 'trial_signed_up');
  const l = db.store[0];
  assert.equal(l.status, 'trial_signed_up');
  // merge, not replace — existing payload keys survive
  assert.deepEqual(l.payload, {
    note: 'קיים', parent_name: 'שירה לוי', child_name: 'יובל', child_age: '8', preferred_day: 'רביעי',
  });
  assert.equal(l.status_history.at(-1).to, 'trial_signed_up');
  assert.equal(l.status_history.at(-1).by, 'auto');
});

test('trial signup on an attended lead banks the fields without moving the status', async () => {
  const db = makeFakeDb({ rows: [seededLead({ status: 'attended' })] });
  leads._setDbForTest(db);
  const out = await recordTrialSignup({ businessId: BIZ, phone: PHONE, fields: { parent_name: 'דנה', child_name: 'איתי' } });
  assert.equal(out.advanced, null);
  assert.equal(db.store[0].status, 'attended');
  assert.equal(db.store[0].payload.child_name, 'איתי');
});

test('trial signup with no lead row creates it fully formed (race safety)', async () => {
  const db = makeFakeDb();
  leads._setDbForTest(db);
  await recordTrialSignup({ businessId: BIZ, phone: PHONE, fields: { parent_name: 'דנה', child_name: 'איתי' } });
  const l = db.store[0];
  assert.equal(l.status, 'trial_signed_up');
  assert.deepEqual(l.payload, { parent_name: 'דנה', child_name: 'איתי' });
});

test('trial signup fails soft on a missing table and a disabled module', async () => {
  leads._setDbForTest(makeFakeDb({ failLeads: true }));
  assert.equal((await recordTrialSignup({ businessId: BIZ, phone: PHONE, fields: { parent_name: 'א', child_name: 'ב' } })).recorded, false);
  const db = makeFakeDb({ enabled: false });
  leads._setDbForTest(db);
  assert.equal((await recordTrialSignup({ businessId: BIZ, phone: PHONE, fields: { parent_name: 'א', child_name: 'ב' } })).recorded, false);
  assert.equal(db.store.length, 0);
});

// ── Manual edits (the portal's PATCH) ────────────────────────────────────────

test('manual status change appends {from,to,at,by} to status_history', async () => {
  const db = makeFakeDb({
    rows: [seededLead({
      status: 'trial_signed_up',
      status_history: [{ from: 'new', to: 'trial_signed_up', at: '2026-08-11T09:00:00.000Z', by: 'auto' }],
    })],
  });
  leads._setDbForTest(db);
  const updated = await applyLeadUpdate(BIZ, 'lead-seed', { status: 'attended' }, 'owner');
  assert.equal(updated.status, 'attended');
  const l = db.store[0];
  assert.equal(l.status_history.length, 2);
  assert.deepEqual(
    { from: l.status_history[1].from, to: l.status_history[1].to, by: l.status_history[1].by },
    { from: 'trial_signed_up', to: 'attended', by: 'owner' });
  assert.ok(l.status_history[1].at);
});

test('manual edits may go anywhere on the board — including backwards and to not_relevant', async () => {
  const db = makeFakeDb({ rows: [seededLead({ status: 'trial_signed_up' })] });
  leads._setDbForTest(db);
  await applyLeadUpdate(BIZ, 'lead-seed', { status: 'not_relevant' });
  assert.equal(db.store[0].status, 'not_relevant');
});

test('notes and whitelisted payload fields update; junk payload keys are dropped', async () => {
  const db = makeFakeDb({ rows: [seededLead({ payload: { parent_name: 'שירה' } })] });
  leads._setDbForTest(db);
  await applyLeadUpdate(BIZ, 'lead-seed', {
    notes: 'לחזור אחרי 17:00',
    payload: { child_age: '9', is_admin: true, phone: 'override' },
  });
  const l = db.store[0];
  assert.equal(l.notes, 'לחזור אחרי 17:00');
  assert.deepEqual(l.payload, { parent_name: 'שירה', child_age: '9' });
  assert.equal(l.phone, PHONE); // payload can never touch real columns
});

test('an unchanged status writes no phantom history entry', async () => {
  const db = makeFakeDb({ rows: [seededLead({ status: 'contacted' })] });
  leads._setDbForTest(db);
  await applyLeadUpdate(BIZ, 'lead-seed', { status: 'contacted', notes: 'רק הערה' });
  assert.deepEqual(db.store[0].status_history, []);
  assert.equal(db.store[0].notes, 'רק הערה');
});

test('unknown status → 400; a lead of another business → 404', async () => {
  leads._setDbForTest(makeFakeDb({ rows: [seededLead()] }));
  await assert.rejects(() => applyLeadUpdate(BIZ, 'lead-seed', { status: 'bogus' }), (e) => e.status === 400);
  await assert.rejects(() => applyLeadUpdate('other-biz', 'lead-seed', { status: 'joined' }), (e) => e.status === 404);
});

// ── List, filter, counts ─────────────────────────────────────────────────────

const boardRows = [
  seededLead({ id: 'l1', phone: '972501111111', display_name: 'שירה', status: 'new', last_contact_at: '2026-08-12T10:00:00.000Z' }),
  seededLead({ id: 'l2', phone: '972502222222', status: 'contacted', payload: { parent_name: 'דנה', child_name: 'איתי' }, last_contact_at: '2026-08-12T09:00:00.000Z' }),
  seededLead({ id: 'l3', phone: '972503333333', status: 'trial_signed_up', last_contact_at: '2026-08-12T08:00:00.000Z' }),
];

test('filterLeads matches status, phone (intl and local), names and notes', () => {
  assert.deepEqual(filterLeads(boardRows, { status: 'contacted' }).map(l => l.id), ['l2']);
  assert.deepEqual(filterLeads(boardRows, { search: '050-111' }).map(l => l.id), ['l1']);
  assert.deepEqual(filterLeads(boardRows, { search: '972502' }).map(l => l.id), ['l2']);
  assert.deepEqual(filterLeads(boardRows, { search: 'שירה' }).map(l => l.id), ['l1']);
  assert.deepEqual(filterLeads(boardRows, { search: 'איתי' }).map(l => l.id), ['l2']);
  assert.equal(filterLeads(boardRows, {}).length, 3);
});

test('leadCounts covers every status (zeros included) plus the total', () => {
  assert.deepEqual(leadCounts(boardRows), {
    all: 3, new: 1, contacted: 1, trial_signed_up: 1, attended: 0, joined: 0, not_relevant: 0,
  });
});

test('listLeadsForApi: disabled module hides the board; missing table means ready:false', async () => {
  leads._setDbForTest(makeFakeDb({ enabled: false }));
  let out = await listLeadsForApi(BIZ, {});
  assert.equal(out.enabled, false);
  assert.equal(out.ready, true);
  assert.deepEqual(out.leads, []);

  leads._setDbForTest(makeFakeDb({ failLeads: true }));
  out = await listLeadsForApi(BIZ, {});
  assert.equal(out.enabled, true);
  assert.equal(out.ready, false);
  assert.deepEqual(out.leads, []);
});

test('listLeadsForApi returns rows (filtered), full counts, and the status catalog', async () => {
  leads._setDbForTest(makeFakeDb({ rows: boardRows }));
  const out = await listLeadsForApi(BIZ, { status: 'new' });
  assert.equal(out.enabled, true);
  assert.deepEqual(out.leads.map(l => l.id), ['l1']);
  assert.equal(out.counts.all, 3); // counts stay unfiltered — they drive the tabs
  assert.deepEqual(out.statuses, LEAD_STATUSES);
});

// ── CSV (the Google Sheet replacement) ───────────────────────────────────────

test('leadsToCsv: BOM + exact Hebrew headers + local phone + Hebrew status labels', () => {
  const csv = leadsToCsv([seededLead({
    display_name: 'שירה לוי', status: 'trial_signed_up',
    payload: { parent_name: 'שירה לוי', child_name: 'יובל', child_age: '8', preferred_day: 'רביעי' },
    notes: 'לחזור מחר',
  })]);
  assert.ok(csv.startsWith('\uFEFF'));
  const lines = csv.replace('\uFEFF', '').trim().split('\r\n');
  assert.equal(lines[0], 'טלפון,שם,סטטוס,שם ההורה,שם הילד/ה,גיל,יום מועדף,פנייה ראשונה,פנייה אחרונה,הערות');
  const row = lines[1].split(',');
  assert.equal(row[0], '0501234567'); // dialable local format, not 972…
  assert.equal(row[1], 'שירה לוי');
  assert.equal(row[2], 'נרשם לניסיון'); // the label, not the key
  assert.equal(row[3], 'שירה לוי');
  assert.equal(row[4], 'יובל');
  assert.equal(row[5], '8');
  assert.equal(row[6], 'רביעי');
  assert.equal(row[9], 'לחזור מחר');
});

test('leadsToCsv escapes commas and quotes; empty board still has headers', () => {
  const csv = leadsToCsv([seededLead({ notes: 'אמא של "יובל", דחוף' })]);
  assert.ok(csv.includes('"אמא של ""יובל"", דחוף"'));
  const empty = leadsToCsv([]);
  assert.ok(empty.includes('טלפון,שם,סטטוס'));
  assert.equal(empty.trim().split('\r\n').length, 1);
});
