// lib/trial-reminders.js — the 09:00 run: cron auth, Jerusalem-day matching,
// the dry-run safety switch, the free-form → template fallback ladder, the
// reminder_sent_on dedupe, and the owner's Telegram summary (incl. zero-skip).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const tr = await import('../lib/trial-reminders.js');
const {
  cronAuthOk, jerusalemDateKey, buildReminderText, buildOwnerSummary, runTrialReminders,
} = tr;
const approvals = await import('../lib/approvals.js');

const BIZ = 'biz-ck';
// 06:00 UTC = 09:00 Asia/Jerusalem in August (IDT, UTC+3) — the real cron hour.
const NOW = new Date('2026-08-12T06:00:00.000Z');
const TODAY = '2026-08-12';

const lead = (over = {}) => ({
  id: over.id ?? 'lead-1', business_id: BIZ, phone: over.phone ?? '972501234567',
  display_name: null, status: 'trial_signed_up', source: 'form',
  payload: { child_name: 'יובל', trial_time: '16:00', trial_date: TODAY },
  ...over,
});

function makeFakeDb({ businesses = [], leadsByBiz = {} } = {}) {
  const updates = [];
  return {
    updates,
    async listLeadsBusinesses() { return businesses; },
    async listLeads(businessId) { return (leadsByBiz[businessId] ?? []).map(l => ({ ...l })); },
    async updateLead(id, patch) { updates.push({ id, patch }); },
  };
}

function armTelegram() {
  process.env.TELEGRAM_BOT_TOKEN = 'tg-token';
  process.env.TELEGRAM_CHAT_ID = '12345';
  const sent = [];
  approvals._setTelegramFetchForTest(async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    return { ok: true };
  });
  return sent;
}

test.afterEach(() => {
  tr._setDbForTest(null);
  tr._setSenderForTest(null);
  tr._setTemplateSenderForTest(null);
  tr._setSheetSyncForTest(null);
  approvals._setTelegramFetchForTest(null);
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  delete process.env.WHATSAPP_TRIAL_REMINDER_TEMPLATE;
});

// ── Cron auth ────────────────────────────────────────────────────────────────

test('cronAuthOk: constant-time bearer — right secret only, sealed when unset', () => {
  assert.equal(cronAuthOk('Bearer s3cret-s3cret-s3cret', 's3cret-s3cret-s3cret'), true);
  assert.equal(cronAuthOk('Bearer wrong0-wrong0-wrong0', 's3cret-s3cret-s3cret'), false);
  assert.equal(cronAuthOk('Bearer short', 's3cret-s3cret-s3cret'), false);
  assert.equal(cronAuthOk('s3cret-s3cret-s3cret', 's3cret-s3cret-s3cret'), false); // no Bearer prefix
  assert.equal(cronAuthOk(undefined, 's3cret-s3cret-s3cret'), false);
  assert.equal(cronAuthOk('Bearer anything', undefined), false); // unset secret NEVER opens the door
  assert.equal(cronAuthOk('Bearer ', ''), false);
});

test('index.js wires POST /cron/trial-reminders through cronAuthOk with a 401', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const at = src.indexOf("app.post('/cron/trial-reminders'");
  assert.ok(at !== -1, 'route exists');
  const body = src.slice(at, at + 800);
  assert.ok(body.includes('cronAuthOk'), 'auth check present');
  assert.ok(body.includes('CRON_SECRET'), 'secret comes from env');
  assert.ok(body.includes('401'), 'unauthorized → 401');
  assert.ok(body.includes('runTrialReminders'), 'runs the real runner');
});

// ── Jerusalem day ────────────────────────────────────────────────────────────

test('jerusalemDateKey: the trial date is an Israel wall date, not a UTC one', () => {
  assert.equal(jerusalemDateKey(NOW), '2026-08-12');
  // 22:30 UTC the day before is already the 12th in Israel (UTC+3 in August)
  assert.equal(jerusalemDateKey(new Date('2026-08-11T22:30:00.000Z')), '2026-08-12');
  // 21:30 UTC on the 12th is already the 13th in Israel
  assert.equal(jerusalemDateKey(new Date('2026-08-12T21:30:00.000Z')), '2026-08-13');
});

// ── Copy ─────────────────────────────────────────────────────────────────────

test('buildReminderText: the exact default copy, with and without child/time', () => {
  assert.equal(
    buildReminderText({ child_name: 'יובל', trial_time: '16:00' }),
    'בוקר טוב! מזכירות שהיום מתקיים אימון הניסיון של יובל בשעה 16:00 — מחכים לכם! נתראה 🐉');
  assert.equal(
    buildReminderText({ child_name: 'יובל' }),
    'בוקר טוב! מזכירות שהיום מתקיים אימון הניסיון של יובל — מחכים לכם! נתראה 🐉');
  assert.equal(
    buildReminderText({}),
    'בוקר טוב! מזכירות שהיום מתקיים אימון הניסיון — מחכים לכם! נתראה 🐉');
});

test('buildReminderText: a per-business reminder_copy override with {שם}/{שעה}', () => {
  assert.equal(
    buildReminderText({ child_name: 'איתי', trial_time: '17:30', copy: 'היי! {שם} מתאמן היום בשעה {שעה} 🥋' }),
    'היי! איתי מתאמן היום בשעה 17:30 🥋');
  // a missing value drops its WHOLE phrase, never just the token
  assert.equal(
    buildReminderText({ copy: 'היי! {שם} מתאמן היום בשעה {שעה} 🥋' }),
    'היי! מתאמן היום 🥋');
});

// The owner-approved kids copy, verbatim — the configure script seeds it as
// reminder_copy, so this pins the EXACT message parents receive.
const KIDS_COPY = 'בוקר טוב! מזכירה לך שנרשמת לאימון נסיון בקרוספיט הדרקונים קידס 🐉 היום בשעה {שעה}. כתובתנו: אילן רמון 5, נס ציונה. נתראה! במידה ואין באפשרותכם להגיע נשמח לעדכון, תודה';

test('the kids copy: hour filled in; unknown hour drops "בשעה {שעה}" but keeps היום', () => {
  assert.equal(
    buildReminderText({ trial_time: '16:00', copy: KIDS_COPY }),
    'בוקר טוב! מזכירה לך שנרשמת לאימון נסיון בקרוספיט הדרקונים קידס 🐉 היום בשעה 16:00. כתובתנו: אילן רמון 5, נס ציונה. נתראה! במידה ואין באפשרותכם להגיע נשמח לעדכון, תודה');
  assert.equal(
    buildReminderText({ copy: KIDS_COPY }),
    'בוקר טוב! מזכירה לך שנרשמת לאימון נסיון בקרוספיט הדרקונים קידס 🐉 היום. כתובתנו: אילן רמון 5, נס ציונה. נתראה! במידה ואין באפשרותכם להגיע נשמח לעדכון, תודה');
});

test('buildOwnerSummary: the exact Telegram copy per outcome mix', () => {
  assert.equal(
    buildOwnerSummary({ dateKey: TODAY, sent: 3, windowFailed: 0, wouldSend: 0 }),
    '🐉 תזכורות אימון ניסיון (12.08.2026): נשלחו 3.');
  assert.equal(
    buildOwnerSummary({ dateKey: TODAY, sent: 2, windowFailed: 1, wouldSend: 0 }),
    '🐉 תזכורות אימון ניסיון (12.08.2026): נשלחו 2. 1 לא נשלחו (מחוץ לחלון).');
  assert.equal(
    buildOwnerSummary({ dateKey: TODAY, sent: 0, windowFailed: 0, wouldSend: 2 }),
    '🐉 תזכורות אימון ניסיון (12.08.2026) — הרצת ניסיון: 2 תזכורות היו נשלחות (המנגנון כבוי עד אישור).');
  // test-redirect mode is named in the summary, with the redirect number
  assert.equal(
    buildOwnerSummary({ dateKey: TODAY, sent: 2, windowFailed: 0, wouldSend: 0, testRecipient: '972520000000' }),
    '🐉 תזכורות אימון ניסיון (12.08.2026): נשלחו 2. (מצב בדיקה — הכל הופנה ל-0520000000)');
  assert.equal(buildOwnerSummary({ dateKey: TODAY, sent: 0, windowFailed: 0, wouldSend: 0 }), null);
});

// ── The run: safety switch (dry-run default) ─────────────────────────────────

test('reminders_enabled absent → dry-run: nothing sent, nothing recorded, dry summary', async () => {
  const db = makeFakeDb({
    businesses: [{ business_id: BIZ, settings: {} }],
    leadsByBiz: { [BIZ]: [lead()] },
  });
  tr._setDbForTest(db);
  const sends = [];
  tr._setSenderForTest(async (msg) => { sends.push(msg); return { messages: [{ id: 'wamid.1' }] }; });
  const tg = armTelegram();

  const out = await runTrialReminders({ now: NOW });
  assert.equal(sends.length, 0);       // the safety switch holds
  assert.equal(db.updates.length, 0);  // no payload write — flipping the switch later still reminds
  assert.equal(out.wouldSend, 1);
  assert.equal(out.sent, 0);
  assert.equal(tg.length, 1);          // the owner still SEES what would have happened
  assert.ok(tg[0].text.includes('הרצת ניסיון'));
});

// ── The run: enabled ─────────────────────────────────────────────────────────

const enabledBiz = (settings = {}) =>
  ({ business_id: BIZ, settings: { reminders_enabled: true, ...settings } });

test('enabled: sends the default copy from the business own number and records the outcome', async () => {
  const db = makeFakeDb({
    businesses: [enabledBiz()],
    leadsByBiz: { [BIZ]: [lead()] },
  });
  tr._setDbForTest(db);
  const sends = [];
  tr._setSenderForTest(async (msg) => { sends.push(msg); return { messages: [{ id: 'wamid.1' }] }; });
  const tg = armTelegram();

  const out = await runTrialReminders({ now: NOW });
  assert.deepEqual(sends, [{
    to: '972501234567', businessId: BIZ, // wa-send resolves the BUSINESS's credentials from this id
    text: 'בוקר טוב! מזכירות שהיום מתקיים אימון הניסיון של יובל בשעה 16:00 — מחכים לכם! נתראה 🐉',
  }]);
  assert.equal(out.sent, 1);
  assert.deepEqual(db.updates, [{
    id: 'lead-1',
    patch: { payload: { child_name: 'יובל', trial_time: '16:00', trial_date: TODAY, reminder_sent_on: TODAY, reminder_status: 'sent' } },
  }]);
  assert.equal(tg[0].text, '🐉 תזכורות אימון ניסיון (12.08.2026): נשלחו 1.');
  assert.equal(tg[0].chat_id, '12345');
});

test('only TODAY (Israel) fires: yesterday, tomorrow, dateless and already-reminded all skip', async () => {
  const db = makeFakeDb({
    businesses: [enabledBiz()],
    leadsByBiz: { [BIZ]: [
      lead({ id: 'l-today' }),
      lead({ id: 'l-yesterday', phone: '972502222221', payload: { trial_date: '2026-08-11' } }),
      lead({ id: 'l-tomorrow', phone: '972502222222', payload: { trial_date: '2026-08-13' } }),
      lead({ id: 'l-dateless', phone: '972502222223', payload: {} }),
      lead({ id: 'l-reminded', phone: '972502222224', payload: { trial_date: TODAY, reminder_sent_on: TODAY, reminder_status: 'sent' } }),
      lead({ id: 'l-not-relevant', phone: '972502222225', status: 'not_relevant' }),
    ] },
  });
  tr._setDbForTest(db);
  const sends = [];
  tr._setSenderForTest(async (msg) => { sends.push(msg); return { messages: [{ id: 'wamid.1' }] }; });
  armTelegram();

  const out = await runTrialReminders({ now: NOW });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].to, '972501234567');
  assert.equal(out.sent, 1);
});

test('a reminder recorded YESTERDAY does not block today (dedupe is per-day)', async () => {
  const db = makeFakeDb({
    businesses: [enabledBiz()],
    leadsByBiz: { [BIZ]: [
      lead({ payload: { trial_date: TODAY, reminder_sent_on: '2026-08-11', reminder_status: 'sent' } }),
    ] },
  });
  tr._setDbForTest(db);
  const sends = [];
  tr._setSenderForTest(async (msg) => { sends.push(msg); return { messages: [{ id: 'wamid.1' }] }; });
  armTelegram();
  const out = await runTrialReminders({ now: NOW });
  assert.equal(out.sent, 1);
  assert.equal(sends.length, 1);
});

// ── Window failure → template fallback ───────────────────────────────────────

test('out-of-window: template approved → template_sent with the hour as {{1}}', async () => {
  process.env.WHATSAPP_TRIAL_REMINDER_TEMPLATE = 'trial_reminder_he';
  const db = makeFakeDb({
    businesses: [enabledBiz()],
    leadsByBiz: { [BIZ]: [lead()] },
  });
  tr._setDbForTest(db);
  tr._setSenderForTest(async () => ({ error: { code: 131047, message: 're-engagement window' } }));
  const templates = [];
  tr._setTemplateSenderForTest(async (msg) => { templates.push(msg); return { messages: [{ id: 'wamid.t1' }] }; });
  const tg = armTelegram();

  const out = await runTrialReminders({ now: NOW });
  assert.deepEqual(templates, [{
    to: '972501234567', templateName: 'trial_reminder_he', langCode: 'he',
    bodyParams: ['16:00'], businessId: BIZ,
  }]);
  assert.equal(out.templateSent, 1);
  assert.equal(out.windowFailed, 0);
  assert.equal(db.updates[0].patch.payload.reminder_status, 'template_sent');
  // a template send still counts as נשלחו in the owner's summary
  assert.equal(tg[0].text, '🐉 תזכורות אימון ניסיון (12.08.2026): נשלחו 1.');
});

test('out-of-window with NO template configured → window_failed, still recorded, summarized', async () => {
  const db = makeFakeDb({
    businesses: [enabledBiz()],
    leadsByBiz: { [BIZ]: [lead()] },
  });
  tr._setDbForTest(db);
  tr._setSenderForTest(async () => undefined); // wa-send returns undefined on fetch error
  const templates = [];
  tr._setTemplateSenderForTest(async (msg) => { templates.push(msg); return { messages: [{ id: 'x' }] }; });
  const tg = armTelegram();

  const out = await runTrialReminders({ now: NOW });
  assert.equal(templates.length, 0); // no template env, no attempt
  assert.equal(out.windowFailed, 1);
  assert.equal(db.updates[0].patch.payload.reminder_status, 'window_failed');
  assert.equal(db.updates[0].patch.payload.reminder_sent_on, TODAY); // recorded either way — no re-spam
  assert.equal(tg[0].text, '🐉 תזכורות אימון ניסיון (12.08.2026): נשלחו 0. 1 לא נשלחו (מחוץ לחלון).');
});

test('template {{1}} falls back to שנקבעה when the hour is unknown', async () => {
  process.env.WHATSAPP_TRIAL_REMINDER_TEMPLATE = 'trial_reminder_he';
  const db = makeFakeDb({
    businesses: [enabledBiz()],
    leadsByBiz: { [BIZ]: [lead({ payload: { trial_date: TODAY } })] },
  });
  tr._setDbForTest(db);
  tr._setSenderForTest(async () => null);
  const templates = [];
  tr._setTemplateSenderForTest(async (msg) => { templates.push(msg); return { messages: [{ id: 'x' }] }; });
  armTelegram();
  await runTrialReminders({ now: NOW });
  assert.deepEqual(templates[0].bodyParams, ['שנקבעה']); // Graph rejects empty params — "היום בשעה שנקבעה"
});

// ── Test-redirect (the owner's hard safety rule) ─────────────────────────────

test('test-redirect: EVERY send goes to the test number only, prefixed, board untouched', async () => {
  process.env.WHATSAPP_TRIAL_REMINDER_TEMPLATE = 'trial_reminder_he';
  const TEST_NUMBER = '972520000000';
  const db = makeFakeDb({
    businesses: [enabledBiz({ reminder_test_recipient: TEST_NUMBER })],
    leadsByBiz: { [BIZ]: [
      lead({ id: 'l-1' }),                                                        // free-form succeeds
      lead({ id: 'l-2', phone: '972502222222', payload: { trial_date: TODAY, trial_time: '17:00' } }), // free-form fails → template
    ] },
  });
  tr._setDbForTest(db);
  const sends = [];
  tr._setSenderForTest(async (msg) => {
    sends.push(msg);
    return msg.text.includes('0501234567') ? { messages: [{ id: 'wamid.1' }] } : null;
  });
  const templates = [];
  tr._setTemplateSenderForTest(async (msg) => { templates.push(msg); return { messages: [{ id: 'wamid.t' }] }; });
  const tg = armTelegram();

  const out = await runTrialReminders({ now: NOW });

  // the hard rule: NO destination other than the test number, ever
  for (const s of [...sends, ...templates]) assert.equal(s.to, TEST_NUMBER);
  assert.ok(sends.length >= 2);

  // the prefix names the REAL target so the tester knows who each message was for
  assert.ok(sends[0].text.startsWith('[בדיקה — היה נשלח אל 0501234567]\n'));
  assert.ok(sends[1].text.startsWith('[בדיקה — היה נשלח אל 0502222222]\n'));

  // a rehearsal leaves the board untouched — going live later still reminds everyone
  assert.equal(db.updates.length, 0);
  assert.deepEqual(out.businesses[0].reminders.map(r => r.redirected_to), [TEST_NUMBER, TEST_NUMBER]);

  // and the owner's summary says it was a test
  assert.equal(tg[0].text, '🐉 תזכורות אימון ניסיון (12.08.2026): נשלחו 2. (מצב בדיקה — הכל הופנה ל-0520000000)');
});

test('dry-run outranks the test recipient: disabled means NOTHING is sent anywhere', async () => {
  const db = makeFakeDb({
    businesses: [{ business_id: BIZ, settings: { reminder_test_recipient: '972520000000' } }],
    leadsByBiz: { [BIZ]: [lead()] },
  });
  tr._setDbForTest(db);
  const sends = [];
  tr._setSenderForTest(async (msg) => { sends.push(msg); return { messages: [{ id: 'x' }] }; });
  armTelegram();
  const out = await runTrialReminders({ now: NOW });
  assert.equal(sends.length, 0);
  assert.equal(out.wouldSend, 1);
  assert.equal(out.businesses[0].mode, 'dry_run');
});

// ── Sheet-sync integration ───────────────────────────────────────────────────

test('a configured sheet syncs BEFORE the reminder pass; a broken sheet does not stop it', async () => {
  const calls = [];
  const db = makeFakeDb({
    businesses: [
      enabledBiz({ sheet_file_id: 'FILE-A' }),
      { business_id: 'biz-b', settings: { reminders_enabled: true, sheet_file_id: 'FILE-B' } },
      { business_id: 'biz-c', settings: { reminders_enabled: true } }, // no sheet — no sync call
    ],
    leadsByBiz: { [BIZ]: [lead()], 'biz-b': [], 'biz-c': [] },
  });
  tr._setDbForTest(db);
  tr._setSheetSyncForTest(async (businessId) => {
    calls.push(businessId);
    if (businessId === 'biz-b') throw new Error('sheet unreachable');
    return { synced: true, updated: 2, created: 1, skipped: 0 };
  });
  const sends = [];
  tr._setSenderForTest(async (msg) => { sends.push(msg); return { messages: [{ id: 'wamid.1' }] }; });
  armTelegram();

  const out = await runTrialReminders({ now: NOW });
  assert.deepEqual(calls, [BIZ, 'biz-b']);
  assert.equal(sends.length, 1); // biz-b's failure cost nobody their reminder
  assert.equal(out.businesses.find(b => b.business_id === 'biz-b').synced.synced, false);
  assert.deepEqual(out.businesses.find(b => b.business_id === BIZ).synced, { synced: true, updated: 2, created: 1, skipped: 0 });
});

// ── Zero-skip ────────────────────────────────────────────────────────────────

test('no lead has a trial today → no send, no payload write, NO Telegram noise', async () => {
  const db = makeFakeDb({
    businesses: [enabledBiz()],
    leadsByBiz: { [BIZ]: [lead({ payload: { trial_date: '2026-09-01' } })] },
  });
  tr._setDbForTest(db);
  tr._setSenderForTest(async () => { throw new Error('must not send'); });
  const tg = armTelegram();

  const out = await runTrialReminders({ now: NOW });
  assert.equal(out.sent + out.windowFailed + out.wouldSend, 0);
  assert.equal(out.summary, null);
  assert.equal(tg.length, 0);
  assert.equal(db.updates.length, 0);
});
