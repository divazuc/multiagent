// The board's in-app conversation view (the owner works from a computer —
// the phone click must NOT bounce her to wa.me):
//   · lib/leads.js#getLeadConversation — business-scoped transcript, 404 for
//     a phone that is not on THIS business's board;
//   · lib/coexistence.js — owner echoes now bank their text into the
//     transcript (action 'owner_echo') so the viewer can label them;
//   · the LeadsManager UI wiring, source-pinned the same way index.js routes
//     are (the studio has no component test runner).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const leads = await import('../lib/leads.js');
const coex = await import('../lib/coexistence.js');

const BIZ = 'biz-ck';
const PHONE = '972501234567';
const PNID = '111222333444555';

const leadRow = (over = {}) => ({
  id: 'lead-1', business_id: BIZ, phone: PHONE, display_name: null,
  status: 'trial_signed_up', source: 'form', payload: {}, status_history: [], ...over,
});

function makeDb({ rows = [], conversations = {}, failConversation = false } = {}) {
  return {
    async getLead(businessId, phone) {
      return rows.find(l => l.business_id === businessId && l.phone === phone) ?? null;
    },
    async listConversation(businessId, phone) {
      if (failConversation) throw new Error('relation "conversation_messages" does not exist');
      return conversations[`${businessId}:${phone}`] ?? [];
    },
  };
}

test.afterEach(() => {
  leads._setDbForTest(null);
  coex._setDbForTest(null);
});

// ── getLeadConversation ──────────────────────────────────────────────────────

test('returns the lead’s transcript — owner-echo rows keep their action marker', async () => {
  const msgs = [
    { user_message: 'היי, רציתי לשאול על אימון ניסיון', agent_response: 'בשמחה! לאיזה גיל?', action: 'none', created_at: '2026-08-11T10:00:00.000Z' },
    { user_message: null, agent_response: 'נדבר מחר, אני אתקשר', action: 'owner_echo', created_at: '2026-08-11T11:00:00.000Z' },
  ];
  leads._setDbForTest(makeDb({
    rows: [leadRow()],
    conversations: { [`${BIZ}:${PHONE}`]: msgs },
  }));
  const out = await leads.getLeadConversation(BIZ, PHONE);
  assert.deepEqual(out, { messages: msgs });
});

test('SCOPING: a phone that is not on this business’s board 404s — even if messages exist', async () => {
  leads._setDbForTest(makeDb({
    rows: [leadRow({ business_id: 'other-biz' })],
    conversations: { [`${BIZ}:${PHONE}`]: [{ user_message: 'x', agent_response: 'y', action: 'none', created_at: '2026-08-11T10:00:00.000Z' }] },
  }));
  await assert.rejects(() => leads.getLeadConversation(BIZ, PHONE), (e) => e.status === 404);
});

test('a lead with no conversation yet gets the empty thread, not an error', async () => {
  leads._setDbForTest(makeDb({ rows: [leadRow()] }));
  assert.deepEqual(await leads.getLeadConversation(BIZ, PHONE), { messages: [] });
});

test('an unreadable messages table degrades to the empty thread (board keeps working)', async () => {
  leads._setDbForTest(makeDb({ rows: [leadRow()], failConversation: true }));
  assert.deepEqual(await leads.getLeadConversation(BIZ, PHONE), { messages: [] });
});

test('missing args are a 400, not a crash', async () => {
  await assert.rejects(() => leads.getLeadConversation(null, PHONE), (e) => e.status === 400);
  await assert.rejects(() => leads.getLeadConversation(BIZ, null), (e) => e.status === 400);
});

// ── Owner-echo transcript persistence (lib/coexistence.js) ───────────────────

function makeCoexDb({ coexistence = true, withSaver = true } = {}) {
  const echoes = [];
  const db = {
    echoes,
    async getBusinessByPhoneNumberId(pnid) { return pnid === PNID ? { id: BIZ } : null; },
    async getCoexistenceSettings() { return { coexistence, coexistence_standdown_minutes: 60 }; },
    async setStanddown() {},
    async getStanddown() { return null; },
  };
  if (withSaver) db.saveEchoMessage = async (row) => { echoes.push(row); };
  return db;
}

test('detectEcho now carries the owner’s text (null for non-text echoes)', () => {
  const body = {
    entry: [{ changes: [{ field: 'message_echoes', value: {
      metadata: { phone_number_id: PNID, display_phone_number: '972559999999' },
      message_echoes: [{ id: 'wamid.E1', to: PHONE, type: 'text', text: { body: 'נתראה מחר בקבוצה!' } }],
    } }] }],
  };
  const e = coex.detectEcho(body);
  assert.equal(e.text, 'נתראה מחר בקבוצה!');
  delete body.entry[0].changes[0].value.message_echoes[0].text;
  assert.equal(coex.detectEcho(body).text, null);
});

test('a text echo lands in the transcript as an owner_echo row for the right session', async () => {
  const db = makeCoexDb();
  coex._setDbForTest(db);
  const out = await coex.handleOwnerEcho({ phoneNumberId: PNID, recipient: PHONE, text: 'נתראה מחר!' });
  assert.equal(out.standdown, true);
  assert.deepEqual(db.echoes, [{ sessionId: PHONE, businessId: BIZ, text: 'נתראה מחר!' }]);
});

test('no text / no saver / saver throwing — the standdown never pays for the transcript', async () => {
  // media echo: nothing to bank
  const db = makeCoexDb();
  coex._setDbForTest(db);
  assert.equal((await coex.handleOwnerEcho({ phoneNumberId: PNID, recipient: PHONE, text: null })).standdown, true);
  assert.equal(db.echoes.length, 0);

  // a fixture that predates the seam function — still fine
  coex._setDbForTest(makeCoexDb({ withSaver: false }));
  assert.equal((await coex.handleOwnerEcho({ phoneNumberId: PNID, recipient: PHONE, text: 'היי' })).standdown, true);

  // a throwing saver fails soft
  const db3 = makeCoexDb();
  db3.saveEchoMessage = async () => { throw new Error('no table'); };
  coex._setDbForTest(db3);
  assert.equal((await coex.handleOwnerEcho({ phoneNumberId: PNID, recipient: PHONE, text: 'היי' })).standdown, true);
});

// ── UI wiring (source-pinned — wa-studio has no component test runner) ───────

const uiSrc = fs.readFileSync(
  new URL('../../wa-studio/src/demo/LeadsManager.jsx', import.meta.url), 'utf8');

test('the board’s phone click opens the IN-APP view; wa.me survives only as the side icon', () => {
  assert.ok(uiSrc.includes('getLeadConversation'), 'calls the scoped conversation op');
  assert.ok(uiSrc.includes('openConvo'), 'phone click handler exists');
  // the phone cell is a BUTTON into the transcript, not a wa.me anchor
  assert.ok(/lm-phone-btn[\s\S]{0,200}openConvo/.test(uiSrc), 'default click = in-app view');
  assert.ok(uiSrc.includes('lm-wa-link'), 'the secondary wa.me icon remains');
  assert.ok(uiSrc.includes('אין עדיין שיחה עם המספר הזה'), 'empty-state copy');
  assert.ok(uiSrc.includes('המאמנת (מהאפליקציה)'), 'owner-echo label');
  assert.ok(uiSrc.includes("action === 'owner_echo'"), 'echo rows are labeled off the action marker');
});

test('the board color-codes per status: dot beside the select + per-status row class', () => {
  assert.ok(uiSrc.includes('lm-dot lm-dot-${lead.status}'), 'status dot');
  assert.ok(uiSrc.includes('lm-row-${lead.status}'), 'row tint per status');
  const css = fs.readFileSync(new URL('../../wa-studio/src/demo/demo.css', import.meta.url), 'utf8');
  for (const key of ['new', 'contacted', 'waitlist_next_date', 'trial_signed_up', 'attended', 'joined', 'not_relevant']) {
    assert.ok(css.includes(`.lm-dot-${key}`), `dot color for ${key}`);
    assert.ok(css.includes(`.lm-row-${key}`), `row tint for ${key}`);
  }
});
