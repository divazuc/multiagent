import test from 'node:test';
import assert from 'node:assert/strict';

// wa-webhook.js imports supabase.js at module top level (same constraint as
// booster-webhook.test.js) — stub the env BEFORE the import.
process.env.SUPABASE_URL = 'http://supabase.invalid';
process.env.SUPABASE_SERVICE_KEY = 'stub-service-key';

const coex = await import('../lib/coexistence.js');
const { detectEcho, handleOwnerEcho, standdownActive, sendUnlessStoodDown } = coex;
const { classifyMetaPayload } = await import('../lib/wa-webhook.js');

// handleOwnerEcho also feeds the leads board (lib/leads.js) — that seam has
// its own tests (leads-wiring.test.js); here it must simply never interfere,
// so the module reads as disabled instead of reaching for the stub supabase.
const leadsLib = await import('../lib/leads.js');
leadsLib._setDbForTest({ isEnabled: async () => false });

// ── Payload fixtures ─────────────────────────────────────────────────────────

const PNID = '111222333444555';
const BIZ_NUMBER = '972548139333';
const CUSTOMER = '972501234567';

// Shape A — the dedicated message_echoes webhook field.
function echoFieldPayload({ field = 'message_echoes', to = CUSTOMER } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba', changes: [{
      field,
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: BIZ_NUMBER, phone_number_id: PNID },
        message_echoes: [{
          from: BIZ_NUMBER, to,
          id: 'wamid.ECHO_A', timestamp: '1770000000',
          type: 'text', text: { body: 'תודה, נתראה מחר!' },
        }],
      },
    }] }],
  };
}

// Shape B — an ordinary `messages` field whose sender is the business's own
// number (outbound direction arriving as inbound).
function echoMessagesPayload({ from = BIZ_NUMBER, display = `+${BIZ_NUMBER}` } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba', changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: display, phone_number_id: PNID },
        contacts: [{ wa_id: CUSTOMER, profile: { name: 'לקוח' } }],
        messages: [{
          from, id: 'wamid.ECHO_B', timestamp: '1770000000',
          type: 'text', text: { body: 'סגרנו, יום רביעי 16:00' },
        }],
      },
    }] }],
  };
}

function customerPayload({ from = CUSTOMER } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba', changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: BIZ_NUMBER, phone_number_id: PNID },
        contacts: [{ wa_id: from, profile: { name: 'לקוח' } }],
        messages: [{ from, id: 'wamid.CUST', type: 'text', text: { body: 'שלום' } }],
      },
    }] }],
  };
}

// ── Echo detection — both shapes ─────────────────────────────────────────────

test('detectEcho recognises the dedicated message_echoes field', () => {
  const e = detectEcho(echoFieldPayload());
  assert.ok(e);
  assert.equal(e.phoneNumberId, PNID);
  assert.equal(e.recipient, CUSTOMER);
  assert.equal(e.msgId, 'wamid.ECHO_A');
});

test('detectEcho recognises the older smb_message_echoes field name', () => {
  const body = echoFieldPayload({ field: 'smb_message_echoes' });
  body.entry[0].changes[0].value.smb_message_echoes = body.entry[0].changes[0].value.message_echoes;
  delete body.entry[0].changes[0].value.message_echoes;
  const e = detectEcho(body);
  assert.ok(e);
  assert.equal(e.recipient, CUSTOMER);
});

test('detectEcho recognises an outbound-direction message on the plain messages field', () => {
  // from === metadata.display_phone_number, compared digits-to-digits so a
  // "+" prefix on either side cannot hide the match.
  const e = detectEcho(echoMessagesPayload());
  assert.ok(e);
  assert.equal(e.phoneNumberId, PNID);
  // no msg.to on this shape — the conversation partner is contacts[0].wa_id
  assert.equal(e.recipient, CUSTOMER);
});

test('detectEcho does NOT flag an ordinary customer message', () => {
  assert.equal(detectEcho(customerPayload()), null);
});

test('detectEcho ignores payloads with no value at all', () => {
  assert.equal(detectEcho({}), null);
  assert.equal(detectEcho(null), null);
  assert.equal(detectEcho({ entry: [{ changes: [{}] }] }), null);
});

// ── classifyMetaPayload — echoes never classify as customer messages ─────────

test('classifyMetaPayload classifies the message_echoes field as echo, not ignore', () => {
  const c = classifyMetaPayload(echoFieldPayload());
  assert.equal(c.kind, 'echo');
  assert.equal(c.echo.recipient, CUSTOMER);
  assert.equal(c.msgId, 'wamid.ECHO_A');
});

test('classifyMetaPayload classifies the messages-field echo shape as echo, not message', () => {
  // THE bug this exists to prevent: before coexistence, this payload
  // classified as kind:"message" and the reply pipeline would have answered
  // the business owner's own words as if a customer wrote them.
  const c = classifyMetaPayload(echoMessagesPayload());
  assert.equal(c.kind, 'echo');
});

test('classifyMetaPayload still classifies a real customer message as message', () => {
  const c = classifyMetaPayload(customerPayload());
  assert.equal(c.kind, 'message');
});

test('classifyMetaPayload still ignores status payloads', () => {
  const c = classifyMetaPayload({ entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'x' }] } }] }] });
  assert.equal(c.kind, 'ignore');
});

// ── Standdown: set by an owner echo, gated on the business flag ──────────────

function fakeDb({ coexistence = true, minutes = 720, standdownUntil = null, business = { id: 'biz-1' } } = {}) {
  const calls = { setStanddown: [] };
  return {
    calls,
    async getBusinessByPhoneNumberId(pnid) { return pnid === PNID ? business : null; },
    async getCoexistenceSettings() { return { coexistence, coexistence_standdown_minutes: minutes }; },
    async setStanddown(sessionId, businessId, untilIso) { calls.setStanddown.push({ sessionId, businessId, untilIso }); },
    async getStanddown() { return standdownUntil; },
  };
}

test('an owner echo arms the standdown for exactly that conversation', async () => {
  const db = fakeDb({ minutes: 720 });
  coex._setDbForTest(db);
  const now = new Date('2026-08-12T10:00:00Z');
  const r = await handleOwnerEcho(detectEcho(echoFieldPayload()), now);
  assert.equal(r.standdown, true);
  assert.equal(db.calls.setStanddown.length, 1);
  assert.equal(db.calls.setStanddown[0].sessionId, CUSTOMER);
  assert.equal(db.calls.setStanddown[0].businessId, 'biz-1');
  // default 720 minutes = 12h
  assert.equal(db.calls.setStanddown[0].untilIso, new Date('2026-08-12T22:00:00Z').toISOString());
  coex._setDbForTest(null);
});

test('a business WITHOUT the coexistence flag gets no standdown from an identical echo', async () => {
  const db = fakeDb({ coexistence: false });
  coex._setDbForTest(db);
  const r = await handleOwnerEcho(detectEcho(echoFieldPayload()));
  assert.equal(r.standdown, false);
  assert.equal(r.reason, 'not_coexistence');
  assert.equal(db.calls.setStanddown.length, 0);
  coex._setDbForTest(null);
});

test('a custom per-business standdown window is honoured', async () => {
  const db = fakeDb({ minutes: 60 });
  coex._setDbForTest(db);
  const now = new Date('2026-08-12T10:00:00Z');
  await handleOwnerEcho(detectEcho(echoFieldPayload()), now);
  assert.equal(db.calls.setStanddown[0].untilIso, new Date('2026-08-12T11:00:00Z').toISOString());
  coex._setDbForTest(null);
});

test('an echo with no resolvable recipient sets nothing and does not throw', async () => {
  const db = fakeDb();
  coex._setDbForTest(db);
  const r = await handleOwnerEcho({ phoneNumberId: PNID, recipient: null });
  assert.equal(r.standdown, false);
  assert.equal(db.calls.setStanddown.length, 0);
  coex._setDbForTest(null);
});

test('a DB failure while arming the standdown is swallowed, never thrown', async () => {
  coex._setDbForTest({
    async getBusinessByPhoneNumberId() { throw new Error('db down'); },
  });
  const r = await handleOwnerEcho(detectEcho(echoFieldPayload()));
  assert.equal(r.standdown, false);
  assert.equal(r.reason, 'error');
  coex._setDbForTest(null);
});

// ── Standdown reads — active window, expiry, fail-soft ───────────────────────

test('standdownActive is true inside the window and false after it expires', async () => {
  coex._setDbForTest(fakeDb({ standdownUntil: '2026-08-12T22:00:00Z' }));
  assert.equal(await standdownActive(CUSTOMER, new Date('2026-08-12T21:59:00Z')), true);
  // expiry restores replies — by time alone, no write needed
  assert.equal(await standdownActive(CUSTOMER, new Date('2026-08-12T22:01:00Z')), false);
  coex._setDbForTest(null);
});

test('standdownActive is false with no standdown recorded', async () => {
  coex._setDbForTest(fakeDb({ standdownUntil: null }));
  assert.equal(await standdownActive(CUSTOMER), false);
  coex._setDbForTest(null);
});

test('standdownActive fails SOFT to false when the column/query errors (pre-migration DBs)', async () => {
  coex._setDbForTest({ async getStanddown() { throw new Error('column sessions.coexistence_standdown_until does not exist'); } });
  assert.equal(await standdownActive(CUSTOMER), false);
  coex._setDbForTest(null);
});

test('an unparseable standdown timestamp reads as not stood down, not as forever', async () => {
  coex._setDbForTest(fakeDb({ standdownUntil: 'garbage' }));
  assert.equal(await standdownActive(CUSTOMER), false);
  coex._setDbForTest(null);
});

// ── Send-time cancellation — the queued/delayed-reply guard ──────────────────

test('sendUnlessStoodDown cancels a queued reply when the owner answered meanwhile', async () => {
  coex._setDbForTest(fakeDb({ standdownUntil: '2026-08-12T22:00:00Z' }));
  let sent = false;
  const r = await sendUnlessStoodDown(CUSTOMER, async () => { sent = true; }, new Date('2026-08-12T21:00:00Z'));
  assert.equal(r.cancelled, true);
  assert.equal(sent, false);
  coex._setDbForTest(null);
});

test('sendUnlessStoodDown sends normally when no standdown is active', async () => {
  coex._setDbForTest(fakeDb({ standdownUntil: null }));
  let sent = false;
  const r = await sendUnlessStoodDown(CUSTOMER, async () => { sent = true; });
  assert.equal(r.cancelled, false);
  assert.equal(sent, true);
  coex._setDbForTest(null);
});

// ── index.js wiring pins ─────────────────────────────────────────────────────
// index.js has no seams (same constraint conversation-modules.test.js works
// under), so the route wiring is pinned at source level: what matters is that
// an echo RETURNS before the pipeline, the standdown gate sits before the
// agent, and the live send goes through the standdown guard.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const indexSrc = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js'), 'utf8');

test('the webhook route consumes an echo before the pipeline ever runs', () => {
  const echoBranch = indexSrc.indexOf("kind === 'echo'");
  const pipelineCall = indexSrc.indexOf('runAgentPipeline(req.body)');
  assert.ok(echoBranch > -1, 'route must branch on kind === "echo"');
  assert.ok(echoBranch < pipelineCall, 'echo branch must come before the pipeline call');
  // the branch is a hard return — no fall-through into the customer path
  const branchBody = indexSrc.slice(echoBranch, indexSrc.indexOf('return;', echoBranch));
  assert.ok(branchBody.includes('handleOwnerEcho'));
  assert.ok(!branchBody.includes('runAgentPipeline'));
});

test('the standdown gate runs before the conversation agent and still logs the message', () => {
  const gate = indexSrc.indexOf("standdownActive(session_id)");
  const agentStep = indexSrc.indexOf("stepStart(run, 'conversation_agent'");
  assert.ok(gate > -1 && gate < agentStep, 'standdown check must precede the agent');
  const gateBlock = indexSrc.slice(gate, gate + 1400);
  assert.ok(gateBlock.includes("from('conversation_messages').insert"), 'customer message must still be logged');
  assert.ok(gateBlock.includes('upsertContact'), 'lead bookkeeping must still run');
  assert.ok(gateBlock.includes("skipped: 'coexistence_standdown'"));
});

test('the live reply send goes through sendUnlessStoodDown (queued replies cancellable)', () => {
  assert.ok(indexSrc.includes('sendUnlessStoodDown(session_id, ()'));
});
