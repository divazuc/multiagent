// Pilot finding #2 (2026-08-12, live): the client's WhatsApp Business app had
// an automatic greeting — customer's first message → instant app auto-reply →
// echo → 12h standdown, silencing the bot for the exact lead it should have
// answered. And our OWN Cloud API sends echo back too: the owner's lead row
// was auto-advanced to 'contacted' by our test-reminder sends.
//
// Two immunities under test here:
//   auto_reply_suspected — echo within standdown_echo_grace_seconds (default
//   25s) of that conversation's last inbound customer message → no standdown;
//   self_send — echo whose message id matches one WE sent (lib/sent-ids.js)
//   → no standdown AND no lead transition.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://supabase.invalid';
process.env.SUPABASE_SERVICE_KEY = 'stub-service-key';

const coex = await import('../lib/coexistence.js');
const { handleOwnerEcho, noteCustomerInbound, _setDbForTest, _clearInboundForTest } = coex;
const { recordSentMessageId, isSelfSendId, _clearSentIdsForTest } = await import('../lib/sent-ids.js');
const leadsLib = await import('../lib/leads.js');

const PNID = 'pnid-immunity-1';
const CUSTOMER = '972501234888';
const BIZ = { id: 'biz-immunity' };

function fakeDb({ graceSeconds = undefined, minutes = 720 } = {}) {
  const calls = { setStanddown: [] };
  const settings = { coexistence: true, coexistence_standdown_minutes: minutes };
  if (graceSeconds !== undefined) settings.standdown_echo_grace_seconds = graceSeconds;
  return {
    calls,
    async getBusinessByPhoneNumberId(pnid) { return pnid === PNID ? BIZ : null; },
    async getCoexistenceSettings() { return settings; },
    async setStanddown(sessionId, businessId, untilIso) { calls.setStanddown.push({ sessionId, businessId, untilIso }); },
    async getStanddown() { return null; },
  };
}

const echo = (msgId = 'wamid.OWNER_REAL') => ({ msgId, phoneNumberId: PNID, recipient: CUSTOMER, text: null });

const T0 = new Date('2026-08-12T19:00:00Z').getTime();
const at = (seconds) => new Date(T0 + seconds * 1000);

test.beforeEach(() => { _clearInboundForTest(); _clearSentIdsForTest(); leadsLib._setDbForTest({ isEnabled: async () => false }); });
test.afterEach(() => { _setDbForTest(null); _clearInboundForTest(); _clearSentIdsForTest(); leadsLib._setDbForTest(null); });

// ── Grace window: the app auto-greeting scenario ─────────────────────────────

test('an echo 5s after the customer wrote is auto_reply_suspected — NO standdown', async () => {
  const db = fakeDb();
  _setDbForTest(db);
  noteCustomerInbound({ phoneNumberId: PNID, from: CUSTOMER }, T0);

  const r = await handleOwnerEcho(echo(), at(5));
  assert.equal(r.standdown, false);
  assert.equal(r.reason, 'auto_reply_suspected');
  assert.equal(db.calls.setStanddown.length, 0);
});

test('an echo 60s after the customer wrote IS the owner — standdown arms normally', async () => {
  const db = fakeDb();
  _setDbForTest(db);
  noteCustomerInbound({ phoneNumberId: PNID, from: CUSTOMER }, T0);

  const r = await handleOwnerEcho(echo(), at(60));
  assert.equal(r.standdown, true);
  assert.equal(db.calls.setStanddown.length, 1);
  assert.equal(db.calls.setStanddown[0].businessId, BIZ.id);
});

test('the window is a per-business setting: 120s catches an echo at 100s', async () => {
  const db = fakeDb({ graceSeconds: 120 });
  _setDbForTest(db);
  noteCustomerInbound({ phoneNumberId: PNID, from: CUSTOMER }, T0);

  const r = await handleOwnerEcho(echo(), at(100));
  assert.equal(r.reason, 'auto_reply_suspected');
  assert.equal(db.calls.setStanddown.length, 0);
});

test('grace 0 disables the immunity — an instant echo still stands down', async () => {
  const db = fakeDb({ graceSeconds: 0 });
  _setDbForTest(db);
  noteCustomerInbound({ phoneNumberId: PNID, from: CUSTOMER }, T0);

  const r = await handleOwnerEcho(echo(), at(1));
  assert.equal(r.standdown, true);
});

test('a business row without the grace column gets the 25s default', async () => {
  const db = fakeDb(); // settings carry no standdown_echo_grace_seconds key
  _setDbForTest(db);
  noteCustomerInbound({ phoneNumberId: PNID, from: CUSTOMER }, T0);

  assert.equal((await handleOwnerEcho(echo(), at(24))).reason, 'auto_reply_suspected');
  assert.equal((await handleOwnerEcho(echo(), at(26))).standdown, true);
});

test('no recorded inbound (restart, or the owner opened the chat) — echo stands down as today', async () => {
  const db = fakeDb();
  _setDbForTest(db);
  const r = await handleOwnerEcho(echo(), at(3));
  assert.equal(r.standdown, true);
});

test('the inbound key is per (number, customer): another customer writing grants no immunity', async () => {
  const db = fakeDb();
  _setDbForTest(db);
  noteCustomerInbound({ phoneNumberId: PNID, from: '972509999999' }, T0);

  const r = await handleOwnerEcho(echo(), at(5));
  assert.equal(r.standdown, true);
});

// ── Self-send ring ───────────────────────────────────────────────────────────

test('an echo of OUR OWN API send is self_send: no standdown, no lead transition, no DB at all', async () => {
  const db = fakeDb();
  _setDbForTest(db);
  // A leads store that would blow up if the echo path ever touched it — and
  // reads as ENABLED, so only the self_send early-return protects it.
  const leadCalls = [];
  leadsLib._setDbForTest({
    isEnabled: async () => true,
    getLead: async (...a) => { leadCalls.push(['getLead', a]); return null; },
    insertLead: async (...a) => { leadCalls.push(['insertLead', a]); },
    updateLead: async (...a) => { leadCalls.push(['updateLead', a]); },
  });

  recordSentMessageId('wamid.OURS_123');
  const r = await handleOwnerEcho(echo('wamid.OURS_123'), at(120));
  assert.equal(r.standdown, false);
  assert.equal(r.reason, 'self_send');
  assert.equal(db.calls.setStanddown.length, 0);
  assert.deepEqual(leadCalls, [], "our own send must not advance the lead to 'contacted'");
});

test('a genuine owner echo with an unknown id is untouched by the ring', async () => {
  const db = fakeDb();
  _setDbForTest(db);
  recordSentMessageId('wamid.OURS_123');
  const r = await handleOwnerEcho(echo('wamid.SOMEONE_ELSE'), at(120));
  assert.equal(r.standdown, true);
});

test('ring entries expire: an id sent 11 minutes ago no longer matches', () => {
  recordSentMessageId('wamid.OLD');
  assert.equal(isSelfSendId('wamid.OLD'), true);
  assert.equal(isSelfSendId('wamid.OLD', Date.now() + 11 * 60 * 1000), false);
});

test('the ring is bounded: the oldest of 201 ids is evicted', () => {
  for (let i = 0; i < 201; i++) recordSentMessageId(`wamid.R${i}`);
  assert.equal(isSelfSendId('wamid.R0'), false);
  assert.equal(isSelfSendId('wamid.R200'), true);
  assert.equal(isSelfSendId('wamid.R1'), true);
});

// ── wa-send.js records what it sent ──────────────────────────────────────────

test('sendWhatsAppMessage and sendWhatsAppTemplate bank the Graph message id in the ring', async (t) => {
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'pnid-env';
  process.env.WHATSAPP_ACCESS_TOKEN = 'token-env';
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  let n = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('graph.facebook.com')) {
      n += 1;
      return { ok: true, json: async () => ({ messages: [{ id: `wamid.SENT_${n}` }] }) };
    }
    throw new Error('no supabase in tests'); // the business lookup fails soft to env creds
  };

  const { sendWhatsAppMessage, sendWhatsAppTemplate } = await import('../lib/wa-send.js');
  await sendWhatsAppMessage({ to: CUSTOMER, text: 'תזכורת', businessId: 'biz-x' });
  await sendWhatsAppTemplate({ to: CUSTOMER, templateName: 'trial_reminder', businessId: 'biz-x' });

  assert.equal(isSelfSendId('wamid.SENT_1'), true);
  assert.equal(isSelfSendId('wamid.SENT_2'), true);
});
