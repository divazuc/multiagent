// lib/leads-sheet.js — the registration-sheet sync: tolerant Hebrew header
// mapping (pinned to the REAL trial-form sheet's header row), slot-string
// date/time extraction, phone normalization, and the upsert that obeys the
// board's iron rules (never downgrade, never touch a human mark).
import test from 'node:test';
import assert from 'node:assert/strict';

const sheet = await import('../lib/leads-sheet.js');
const {
  parseCsv, mapHeaders, normalizeSheetPhone, parseTrialDate, parseTrialTime,
  parseSheetCsv, upsertSheetRow, syncSheetLeads,
} = sheet;
const leads = await import('../lib/leads.js');

const BIZ = 'biz-ck';

function makeFakeDb({ enabled = true, settings = {}, rows = [] } = {}) {
  let seq = 0;
  const store = rows.map(r => ({ ...r }));
  return {
    store,
    async getLeadsModule() { return { enabled, settings }; },
    async getLead(businessId, phone) {
      return store.find(l => l.business_id === businessId && l.phone === phone) ?? null;
    },
    async insertLead(row) {
      const withId = { id: `lead-${++seq}`, ...row };
      store.push(withId);
      return withId;
    },
    async updateLead(id, patch) {
      const i = store.findIndex(l => l.id === id);
      if (i === -1) throw new Error('no such lead');
      store[i] = { ...store[i], ...patch };
    },
  };
}

const seededLead = (over = {}) => ({
  id: 'lead-seed', business_id: BIZ, phone: '972501234567', display_name: null,
  status: 'new', source: 'whatsapp',
  first_contact_at: '2026-08-10T08:00:00.000Z', last_contact_at: '2026-08-10T08:00:00.000Z',
  last_direction: 'in', payload: {}, notes: null, status_history: [], ...over,
});

test.afterEach(() => {
  sheet._setDbForTest(null);
  sheet._setCsvFetcherForTest(null);
  leads._setDbForTest(null);
});

// ── CSV mechanics ────────────────────────────────────────────────────────────

test('parseCsv handles quoted cells, embedded commas/quotes/newlines, CRLF and BOM', () => {
  const csv = '﻿א,ב,ג\r\n"עם, פסיק","עם ""מרכאות""","שתי\nשורות"\r\n';
  assert.deepEqual(parseCsv(csv), [
    ['א', 'ב', 'ג'],
    ['עם, פסיק', 'עם "מרכאות"', 'שתי\nשורות'],
  ]);
});

// ── Header detection ─────────────────────────────────────────────────────────

// The REAL registration sheet's header row, byte-for-byte.
const REAL_HEADERS = ['תאריך ושעה', 'שם ההורה', 'טלפון', 'שם הילד/ה', 'גיל', 'קבוצה',
  'איך שמעתם עלינו', 'הערות', 'אישור תקנון', 'מקור',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'מועד ניסיון'];

test('mapHeaders: the real trial-form sheet maps exactly right', () => {
  const { map, unmatched } = mapHeaders(REAL_HEADERS);
  assert.deepEqual(map, {
    0: 'submitted_at',   // 'תאריך ושעה' is the SUBMISSION timestamp, not the trial date
    1: 'parent_name',
    2: 'phone',
    3: 'child_name',
    4: 'child_age',
    5: 'group',
    7: 'note',
    10: 'utm_source',
    12: 'utm_campaign',
    15: 'trial_date',    // 'מועד ניסיון' — the slot string
  });
  assert.deepEqual(unmatched, ['איך שמעתם עלינו', 'אישור תקנון', 'מקור', 'utm_medium', 'utm_content', 'utm_term']);
});

test('mapHeaders: simpler sheets still map — separate תאריך/שעה columns, נייד as phone', () => {
  const { map } = mapHeaders(['שם מלא', 'נייד', 'תאריך האימון', 'שעה', 'שם הילד/ה', 'גיל הילד']);
  assert.deepEqual(map, {
    0: 'parent_name', 1: 'phone', 2: 'trial_date', 3: 'trial_time', 4: 'child_name', 5: 'child_age',
  });
});

test('mapHeaders: מועד is a date but יום מועדף is NOT; first match wins per field', () => {
  const { map, unmatched } = mapHeaders(['טלפון', 'מועד הניסיון', 'יום מועדף', 'טלפון נוסף']);
  assert.deepEqual(map, { 0: 'phone', 1: 'trial_date' });
  assert.deepEqual(unmatched, ['יום מועדף', 'טלפון נוסף']);
});

// ── Cell normalization ───────────────────────────────────────────────────────

test('normalizeSheetPhone: local, dashed, +972 and bare-9-digit forms all normalize', () => {
  assert.equal(normalizeSheetPhone('0505283928'), '972505283928');
  assert.equal(normalizeSheetPhone('050-528 3928'), '972505283928');
  assert.equal(normalizeSheetPhone('+972505283928'), '972505283928');
  assert.equal(normalizeSheetPhone('972505283928'), '972505283928');
  assert.equal(normalizeSheetPhone('505283928'), '972505283928');
  assert.equal(normalizeSheetPhone('בטלפון'), null);
  assert.equal(normalizeSheetPhone('123'), null);
  assert.equal(normalizeSheetPhone(''), null);
});

test('parseTrialDate: ISO, dd/mm/yyyy, dd.mm.yy AND the form slot string', () => {
  assert.equal(parseTrialDate('2026-08-14'), '2026-08-14');
  assert.equal(parseTrialDate('14/08/2026'), '2026-08-14');
  assert.equal(parseTrialDate('14/8/2026'), '2026-08-14');
  assert.equal(parseTrialDate('14.8.26'), '2026-08-14');
  // the real form's combined slot value
  assert.equal(parseTrialDate('יום רביעי 12/08/2026 · בשעה 16:00'), '2026-08-12');
  assert.equal(parseTrialDate('14/13/2026'), null);
  assert.equal(parseTrialDate('מחר'), null);
  assert.equal(parseTrialDate(''), null);
});

test('parseTrialTime: whole-cell forms, the slot string, and no date false-positives', () => {
  assert.equal(parseTrialTime('16:30'), '16:30');
  assert.equal(parseTrialTime('16.30'), '16:30');
  assert.equal(parseTrialTime('9:00:00'), '9:00');
  // pulled out of the slot string…
  assert.equal(parseTrialTime('יום רביעי 12/08/2026 · בשעה 16:00'), '16:00');
  // …but a date alone must never cough up a fake time
  assert.equal(parseTrialTime('יום רביעי 12/08/2026'), null);
  assert.equal(parseTrialTime('99:00'), null);
  assert.equal(parseTrialTime('16:75'), null);
  assert.equal(parseTrialTime('אחר הצהריים'), null);
});

// ── Sheet → rows (the real format) ───────────────────────────────────────────

const REAL_CSV = [
  REAL_HEADERS.join(','),
  '10/08/2026 14:23,שירה לוי,0505283928,יובל,8,דרקונים צעירים,חבר,אלרגיה לבוטנים,כן,facebook,fb,cpc,kids-trial,ad1,term1,יום רביעי 12/08/2026 · בשעה 16:00',
  '11/08/2026 09:10,דנה כהן,+972502222222,איתי,7,,,,,,,,,,,',
  '11/08/2026 10:00,בלי טלפון,,נועם,6,,,,,,,,,,,יום חמישי 13/08/2026 · בשעה 17:00',
  ',,,,,,,,,,,,,,,',
].join('\r\n');

test('parseSheetCsv: real rows land structured — slot string split into date+time', () => {
  const { rows, skipped } = parseSheetCsv(REAL_CSV);
  assert.equal(rows.length, 2);
  assert.equal(skipped, 1); // the no-phone row; the all-blank line is not an error
  assert.deepEqual(rows[0], {
    phone: '972505283928', parent_name: 'שירה לוי', child_name: 'יובל', child_age: '8',
    trial_date: '2026-08-12', trial_time: '16:00',
    group: 'דרקונים צעירים', note: 'אלרגיה לבוטנים',
    utm_source: 'fb', utm_campaign: 'kids-trial', submitted_at: '10/08/2026 14:23',
  });
  // "coordinate later" — empty slot: a normal signup with no reminder date
  assert.equal(rows[1].phone, '972502222222');
  assert.equal(rows[1].trial_date, null);
  assert.equal(rows[1].trial_time, null);
});

test('parseSheetCsv: an unparseable slot keeps the row, a missing phone column syncs nothing', () => {
  const { rows } = parseSheetCsv('טלפון,מועד ניסיון\r\n0501234567,מחר בבוקר');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].trial_date, null);

  const none = parseSheetCsv('שם,הערות\r\nשירה,בלי מספר');
  assert.deepEqual(none.rows, []);
  assert.equal(none.skipped, 1);
});

// ── Upsert rules ─────────────────────────────────────────────────────────────

const row = (over = {}) => ({
  phone: '972501234567', parent_name: 'שירה לוי', child_name: 'יובל',
  child_age: '8', trial_date: '2026-08-14', trial_time: '16:30', ...over,
});

test('a new phone becomes a fully-formed form lead at trial_signed_up', async () => {
  const db = makeFakeDb();
  sheet._setDbForTest(db);
  const now = new Date('2026-08-12T06:00:00.000Z');
  const out = await upsertSheetRow(BIZ, row({ group: 'דרקונים', utm_source: 'fb' }), now);
  assert.deepEqual(out, { created: true, updated: true });
  const l = db.store[0];
  assert.equal(l.source, 'form');
  assert.equal(l.status, 'trial_signed_up');
  assert.equal(l.display_name, 'שירה לוי');
  assert.deepEqual(l.payload, {
    parent_name: 'שירה לוי', child_name: 'יובל', child_age: '8',
    trial_date: '2026-08-14', trial_time: '16:30', group: 'דרקונים', utm_source: 'fb',
  });
  assert.deepEqual(l.status_history, [{ from: null, to: 'trial_signed_up', at: now.toISOString(), by: 'sheet' }]);
});

test('an existing WhatsApp lead is enriched and laddered up — source stays whatsapp', async () => {
  const db = makeFakeDb({ rows: [seededLead({ status: 'contacted', payload: { note: 'קיים' } })] });
  sheet._setDbForTest(db);
  await upsertSheetRow(BIZ, row({ note: null }));
  const l = db.store[0];
  assert.equal(l.source, 'whatsapp');
  assert.equal(l.status, 'trial_signed_up');
  assert.equal(l.display_name, 'שירה לוי'); // backfilled — was null
  assert.equal(l.payload.note, 'קיים');     // merge, not replace
  assert.equal(l.payload.trial_date, '2026-08-14');
  assert.equal(l.status_history.at(-1).by, 'sheet');
});

test('the sheet NEVER downgrades: attended/joined keep their status, fields still bank', async () => {
  for (const status of ['attended', 'joined']) {
    const db = makeFakeDb({ rows: [seededLead({ status })] });
    sheet._setDbForTest(db);
    await upsertSheetRow(BIZ, row());
    assert.equal(db.store[0].status, status);
    assert.equal(db.store[0].payload.trial_date, '2026-08-14');
    assert.deepEqual(db.store[0].status_history, []); // no phantom transition
  }
});

// ── The waitlist rule (empty מועד ניסיון) ────────────────────────────────────

test('a dateless signup lands as waitlist_next_date — wants a trial, no open date', async () => {
  const db = makeFakeDb();
  sheet._setDbForTest(db);
  const out = await upsertSheetRow(BIZ, row({ trial_date: null, trial_time: null }));
  assert.deepEqual(out, { created: true, updated: true });
  assert.equal(db.store[0].status, 'waitlist_next_date');
  assert.equal(db.store[0].source, 'form');
  assert.equal(db.store[0].status_history[0].to, 'waitlist_next_date');
});

test('dateless row: contacted advances to waitlist; a dated signup never falls back to it', async () => {
  const db = makeFakeDb({ rows: [seededLead({ status: 'contacted' })] });
  sheet._setDbForTest(db);
  await upsertSheetRow(BIZ, row({ trial_date: null, trial_time: null }));
  assert.equal(db.store[0].status, 'waitlist_next_date');

  const db2 = makeFakeDb({ rows: [seededLead({ status: 'trial_signed_up' })] });
  sheet._setDbForTest(db2);
  await upsertSheetRow(BIZ, row({ trial_date: null, trial_time: null }));
  assert.equal(db2.store[0].status, 'trial_signed_up'); // waitlist ranks below — no downgrade
});

test('a waitlisted lead is promoted to trial_signed_up the moment a date appears', async () => {
  const db = makeFakeDb({ rows: [seededLead({ status: 'waitlist_next_date' })] });
  sheet._setDbForTest(db);
  await upsertSheetRow(BIZ, row());
  assert.equal(db.store[0].status, 'trial_signed_up');
  assert.deepEqual(
    { from: db.store[0].status_history.at(-1).from, to: db.store[0].status_history.at(-1).to, by: db.store[0].status_history.at(-1).by },
    { from: 'waitlist_next_date', to: 'trial_signed_up', by: 'sheet' });
});

test('a human not_relevant mark is never overwritten by the sheet', async () => {
  const db = makeFakeDb({ rows: [seededLead({ status: 'not_relevant' })] });
  sheet._setDbForTest(db);
  await upsertSheetRow(BIZ, row());
  assert.equal(db.store[0].status, 'not_relevant');
});

test('a resync with identical values writes nothing', async () => {
  const db = makeFakeDb({
    rows: [seededLead({
      status: 'trial_signed_up', display_name: 'שירה לוי',
      payload: {
        parent_name: 'שירה לוי', child_name: 'יובל', child_age: '8',
        trial_date: '2026-08-14', trial_time: '16:30',
      },
    })],
  });
  sheet._setDbForTest(db);
  const out = await upsertSheetRow(BIZ, row());
  assert.deepEqual(out, { created: false, updated: false });
});

test('an empty sheet cell never blanks an existing payload value', async () => {
  const db = makeFakeDb({
    rows: [seededLead({ status: 'trial_signed_up', payload: { child_name: 'יובל', trial_time: '16:30' } })],
  });
  sheet._setDbForTest(db);
  await upsertSheetRow(BIZ, row({ child_name: null, trial_time: null, trial_date: '2026-08-14' }));
  assert.equal(db.store[0].payload.child_name, 'יובל');
  assert.equal(db.store[0].payload.trial_time, '16:30');
});

// ── The full sync ────────────────────────────────────────────────────────────

test('syncSheetLeads: fetches the configured sheet+gid and reports updated/created/skipped', async () => {
  const db = makeFakeDb({
    settings: { sheet_file_id: '1pFmock-file-id', sheet_gid: '424242' },
    rows: [seededLead({ phone: '972502222222', status: 'joined' })],
  });
  sheet._setDbForTest(db);
  const fetches = [];
  sheet._setCsvFetcherForTest(async (fileId, gid) => { fetches.push({ fileId, gid }); return REAL_CSV; });

  const out = await syncSheetLeads(BIZ, { now: new Date('2026-08-12T06:00:00.000Z') });
  assert.deepEqual(fetches, [{ fileId: '1pFmock-file-id', gid: '424242' }]);
  assert.equal(out.synced, true);
  assert.equal(out.created, 1);  // שירה is new; דנה is the existing joined lead
  assert.equal(out.updated, 2);  // דנה's payload gained the form fields (status untouched)
  assert.equal(out.skipped, 1);
  const dana = db.store.find(l => l.phone === '972502222222');
  assert.equal(dana.status, 'joined'); // still no downgrade
  assert.equal(dana.payload.child_name, 'איתי');
});

test('syncSheetLeads: no sheet configured / module disabled → operator-visible 400', async () => {
  sheet._setDbForTest(makeFakeDb({ settings: {} }));
  await assert.rejects(() => syncSheetLeads(BIZ), (e) => e.status === 400 && /sheet/.test(e.message));
  sheet._setDbForTest(makeFakeDb({ enabled: false, settings: { sheet_file_id: 'F' } }));
  await assert.rejects(() => syncSheetLeads(BIZ), (e) => e.status === 400);
});

// ── The board flag that shows the sync button ────────────────────────────────

test('listLeadsForApi surfaces sheet_configured off the module settings', async () => {
  leads._setDbForTest({
    async getLeadsModule() { return { enabled: true, settings: { sheet_file_id: '1pFmock-file-id' } }; },
    async listLeads() { return []; },
  });
  let out = await leads.listLeadsForApi(BIZ, {});
  assert.equal(out.enabled, true);
  assert.equal(out.sheet_configured, true);

  leads._setDbForTest({
    async getLeadsModule() { return { enabled: true, settings: {} }; },
    async listLeads() { return []; },
  });
  out = await leads.listLeadsForApi(BIZ, {});
  assert.equal(out.sheet_configured, false);
});
