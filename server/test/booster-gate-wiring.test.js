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
const { handleBlockedBooking, BLOCKED_REPLY, recordMeetingBooked, _setRelayForTest, _setDbForTest } = meeting;
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

test('index.js gates calendar bookings before executeModuleAction and swaps in the blocked reply', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const gateIdx = src.indexOf('gateCalendarBooking(');
  const execIdx = src.indexOf('executeModuleAction(');
  assert.ok(gateIdx > -1, 'the gate must be called in the pipeline');
  assert.ok(execIdx > -1);
  assert.ok(gateIdx < execIdx, 'the gate must run BEFORE the action executes');
  assert.match(src, /handleBlockedBooking\(/, 'a block relays to Diva and produces the fixed reply');
  assert.match(src, /responseOverride \?\?/, 'a block replaces the model text entirely, not appended to it');
  assert.match(src, /event_title_override = gate\.eventTitleOverride/,
    'the characterization title must reach the calendar module through sessionCtx');
});

test('index.js records meeting_booked after a successful gated express booking', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const execIdx = src.indexOf('executeModuleAction(');
  const bookedIdx = src.indexOf('recordMeetingBooked(');
  assert.ok(bookedIdx > execIdx, 'the note is written only AFTER the action succeeded');
  assert.match(src, /gate\.expressLead/, 'only an express lead booking is noted — regular tenants unaffected');
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
