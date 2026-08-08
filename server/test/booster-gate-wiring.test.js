// server/test/booster-gate-wiring.test.js
//
// T7 (funnel track 1) — enforcement in the pipeline:
//   · index.js runs gateCalendarBooking BEFORE executeModuleAction; a block
//     swaps the whole reply for the fixed line + relays to Diva (source-pinned
//     here the same way conversation-modules.test.js pins index.js wiring,
//     because index.js itself boots the full server).
//   · handleBlockedBooking (the functional half of that wiring) really pings
//     the relay and always returns the fixed reply.
//   · the booster's 3-day send_meeting_reminder is suppressed once a
//     meeting_booked note exists (F2 — the booster doesn't know about the
//     booking until v1.1), failing OPEN when the notes store is unreadable.
// Fresh event_ids everywhere: the webhook's dedup Set persists per process.
process.env.SUPABASE_URL = 'http://supabase.invalid';
process.env.SUPABASE_SERVICE_KEY = 'stub-service-key';
process.env.BOT_WEBHOOK_SECRET = 'test-secret-0123456789abcdef';
process.env.DIVAZ_BUSINESS_ID = 'biz-diva-test';
process.env.MODULE_SECRETS_KEY = Buffer.alloc(32).toString('base64');

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';

const meeting = await import('../lib/booster-meeting.js');
const { handleBlockedBooking, BLOCKED_REPLY, recordMeetingBooked, recordMeetingRequested,
  _setRelayForTest, _setDbForTest } = meeting;
const { default: boosterWebhookRouter, _setSendForTest, _setSlotsFetcherForTest } =
  await import('../routes/booster-webhook.js');

function startServer() {
  const app = express();
  app.use(express.json());
  app.use(boosterWebhookRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function post(server, body) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/booster-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.BOT_WEBHOOK_SECRET}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const lead = { name: 'PWTEST Lead', phone: '0520000000' };
const reminderBody = (event_id) =>
  ({ event_id, lead_id: 'PWTEST-lead', event: 'send_meeting_reminder', payload: { quote_number: 'DZ-1' }, lead });

test.afterEach(() => {
  _setRelayForTest(null);
  _setDbForTest(null);
  _setSendForTest(null);
  _setSlotsFetcherForTest(null);
});

// ── handleBlockedBooking ─────────────────────────────────────────────────────

test('handleBlockedBooking pings Diva through the relay and returns the fixed reply', async () => {
  const raised = [];
  _setRelayForTest(async (args) => { raised.push(args); return { holdingLine: 'x' }; });
  const reply = await handleBlockedBooking({
    business: { id: 'b1', name: 'Diva Ost' },
    session_id: '972521234567',
    question: 'אפשר לקבוע עוד פגישה מחר?',
    history: [{ role: 'user', content: 'היי' }],
    persona: { bot_gender: 'female' },
  });
  assert.equal(reply, BLOCKED_REPLY);
  assert.equal(reply, 'דיוה תחזור אליך בהקדם 🙂');
  assert.equal(raised.length, 1);
  assert.equal(raised[0].business.id, 'b1');
  assert.equal(raised[0].session_id, '972521234567');
  assert.equal(raised[0].question, 'אפשר לקבוע עוד פגישה מחר?', 'Diva must see the actual request');
});

test('handleBlockedBooking returns the fixed reply even when the relay throws — the client is never left unanswered', async () => {
  _setRelayForTest(async () => { throw new Error('no escalation template'); });
  const reply = await handleBlockedBooking({
    business: { id: 'b1', name: 'Diva Ost' }, session_id: '972521234567', question: 'עוד פגישה?',
  });
  assert.equal(reply, BLOCKED_REPLY);
});

// ── index.js wiring (source pins — the pipeline boots a full server) ─────────

// The step's BEHAVIOUR is asserted for real in module-action-step.test.js
// (these pins used to be all there was, and `gateIdx < execIdx` would pass
// even with an inverted condition). What is left here is only the wiring a
// unit test cannot see: index.js delegates to the step, and sends the composed
// reply exactly once.
test('index.js delegates the module action to the tested step and sends its reply exactly once', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(src, /runModuleActionStep\(/, 'the pipeline must go through the tested step');
  assert.doesNotMatch(src, /נתפס|לא זמין/,
    'the pipeline must not sniff the calendar module\'s Hebrew copy to detect success');
  assert.match(src, /const outbound_response = moduleStep\.text/,
    'the step composes the whole reply — a block replaces it rather than being appended to');
  const sends = src.match(/sendWhatsAppMessage\(\{ to: session_id, text: outbound_response/g) ?? [];
  assert.equal(sends.length, 1, 'exactly one outbound send per reply, blocked or not');
});

// ── reminder suppression (F2) ────────────────────────────────────────────────

test('send_meeting_reminder is suppressed (acked + remembered) when a meeting_booked note exists', async () => {
  const server = await startServer();
  const db = { events: [] };
  _setDbForTest(db);
  await recordMeetingBooked({ businessId: 'biz-diva-test', phone: '0520000000', quoteNumber: 'DZ-1', slot: '2026-08-10T10:00' });
  let sendCalled = false;
  _setSendForTest(async () => { sendCalled = true; return { messages: [{ id: 'wamid.OK' }] }; });
  try {
    const r = await post(server, reminderBody('evt-gate-suppress-1'));
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, skipped: true });
    assert.equal(sendCalled, false, 'the client already booked — no nag message');

    const again = await post(server, reminderBody('evt-gate-suppress-1'));
    assert.deepEqual(again.json, { ok: true, deduped: true }, 'a suppressed event is remembered, never retried forever');
  } finally {
    server.close();
  }
});

test('a PENDING meeting_requested does not suppress the reminder — only a confirmed meeting does', async () => {
  const server = await startServer();
  _setDbForTest({ events: [] });
  _setSlotsFetcherForTest(async () => []);
  const sent = [];
  _setSendForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.OK' }] }; });
  // owner_confirmed booking: the client was told "נאשר לך סופית בהקדם" and
  // Diva may yet decline. If that killed the reminder too, a declined request
  // would leave the client with nothing at all.
  await recordMeetingRequested({ businessId: 'biz-diva-test', phone: '0520000000', quoteNumber: 'DZ-1', slot: '2026-08-10T10:00' });
  try {
    const r = await post(server, reminderBody('evt-gate-pending-1'));
    assert.deepEqual(r.json, { ok: true });
    assert.equal(sent.length, 1, 'the reminder is the safety net for a request that never got confirmed');
  } finally {
    server.close();
  }
});

test("send_meeting_reminder for a NEW order is not suppressed by the previous order's booking", async () => {
  const server = await startServer();
  _setDbForTest({ events: [] });
  _setSlotsFetcherForTest(async () => []); // keep the meeting-slot path quiet
  const sent = [];
  _setSendForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.OK' }] }; });
  await recordMeetingBooked({ businessId: 'biz-diva-test', phone: '0520000000', quoteNumber: 'DZ-1', slot: '2026-08-10T10:00' });
  try {
    // Same order (payload DZ-1) — the client really did already book.
    const sameOrder = await post(server, reminderBody('evt-gate-order-same-1'));
    assert.deepEqual(sameOrder.json, { ok: true, skipped: true });
    assert.equal(sent.length, 0);

    // A second order's reminder must not be silently killed by the first
    // order's booking — that is the same repeat-customer lockout the gate has.
    const newOrder = await post(server, {
      event_id: 'evt-gate-order-new-1', lead_id: 'PWTEST-lead',
      event: 'send_meeting_reminder', payload: { quote_number: 'DZ-2' }, lead,
    });
    assert.deepEqual(newOrder.json, { ok: true });
    assert.equal(sent.length, 1, "the new order's reminder must reach the client");
  } finally {
    server.close();
  }
});

test('send_meeting_reminder still goes out when the note is for another phone or the store is unreadable (fail-open)', async () => {
  const server = await startServer();
  const sent = [];
  _setSendForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.OK' }] }; });
  _setSlotsFetcherForTest(async () => []); // keep the meeting-slot path quiet

  const db = { events: [] };
  _setDbForTest(db);
  await recordMeetingBooked({ businessId: 'biz-diva-test', phone: '0539999999', quoteNumber: 'DZ-2', slot: '2026-08-10T10:00' });
  try {
    const other = await post(server, reminderBody('evt-gate-other-phone-1'));
    assert.deepEqual(other.json, { ok: true });
    assert.equal(sent.length, 1, "another client's booking must not silence this reminder");

    _setDbForTest({ get events() { throw new Error('store down'); } });
    const broken = await post(server, reminderBody('evt-gate-broken-store-1'));
    assert.deepEqual(broken.json, { ok: true });
    assert.equal(sent.length, 2, 'an unreadable store fails OPEN — the reminder is sent, not lost');
  } finally {
    server.close();
  }
});
