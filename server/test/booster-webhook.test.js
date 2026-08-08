// server/test/booster-webhook.test.js
//
// Fix round 1 — the message-template unit tests never exercised the route's
// own success/failure branching, which is what hid the bug: wa-send.js
// resolves (never rejects) on every failure, so a naive try/catch around the
// send could never see a failure and the 502 branch was dead code. Every
// real-world failure — Graph rejecting the message, a 24h-window bounce,
// missing WhatsApp credentials, a Supabase lookup error — would have acked
// 200 and permanently remembered the event_id, so the booster marks it
// 'sent' while the client silently never gets the message.
//
// These tests inject a stub sender via _setSendForTest and assert both the
// HTTP response AND whether the event_id was remembered: a second POST with
// the same id must only dedupe if the first attempt actually succeeded (or
// was legitimately skipped) — never after a failed send, or a real retry
// from the booster's outbox would be swallowed as a false dedupe.
process.env.SUPABASE_URL = 'http://supabase.invalid';
process.env.SUPABASE_SERVICE_KEY = 'stub-service-key';
process.env.BOT_WEBHOOK_SECRET = 'test-secret-0123456789abcdef';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

// Dynamic import, not static: booster-webhook.js -> wa-send.js -> supabase.js
// calls createClient(SUPABASE_URL, ...) at module-evaluation time, and ESM
// hoists static imports ahead of this file's own top-level statements — the
// env vars above would not be set yet. A dynamic import() is a runtime
// expression, evaluated in place, so it runs after they are.
const { default: boosterWebhookRouter, _setSendForTest } = await import('../routes/booster-webhook.js');

function startServer() {
  const app = express();
  app.use(express.json());
  app.use(boosterWebhookRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function post(server, body, { bearer = process.env.BOT_WEBHOOK_SECRET } = {}) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/booster-webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(bearer !== null ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const lead = { name: 'PWTEST Lead', phone: '0520000000' };
const validBody = (event_id, event = 'send_personal_link', payload = { link_url: 'https://x/y', valid_days: 14 }) =>
  ({ event_id, lead_id: 'PWTEST-lead', event, payload, lead });

test('a successful send acks 200, and a repeat of the same event_id dedupes', async () => {
  const server = await startServer();
  _setSendForTest(async () => ({ messages: [{ id: 'wamid.OK' }] }));
  try {
    const first = await post(server, validBody('evt-success-1'));
    assert.equal(first.status, 200);
    assert.deepEqual(first.json, { ok: true });

    const second = await post(server, validBody('evt-success-1'));
    assert.equal(second.status, 200);
    assert.deepEqual(second.json, { ok: true, deduped: true });
  } finally {
    _setSendForTest(null);
    server.close();
  }
});

test('a Graph error response is a 502 and the event_id is NOT remembered — a later retry that succeeds acks 200', async () => {
  const server = await startServer();
  _setSendForTest(async () => ({ error: { code: 131047, message: 're-engagement window closed' } }));
  try {
    const failed = await post(server, validBody('evt-retry-1'));
    assert.equal(failed.status, 502, 'a Graph error body must not be read as success');
    assert.deepEqual(failed.json, { ok: false });

    // The booster's outbox retries the same event_id — this time the send succeeds.
    _setSendForTest(async () => ({ messages: [{ id: 'wamid.RETRY_OK' }] }));
    const retried = await post(server, validBody('evt-retry-1'));
    assert.equal(retried.status, 200);
    assert.deepEqual(retried.json, { ok: true },
      'must not have been deduped — the failed attempt was never remembered');
  } finally {
    _setSendForTest(null);
    server.close();
  }
});

test('an undefined result (missing credentials, or any other non-Graph-shape resolve) is a 502, not a false success', async () => {
  // This is the exact shape wa-send.js resolves with on missing WhatsApp
  // credentials — the scenario that motivated this fix.
  const server = await startServer();
  _setSendForTest(async () => undefined);
  try {
    const r = await post(server, validBody('evt-undefined-1'));
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, { ok: false });
  } finally {
    _setSendForTest(null);
    server.close();
  }
});

test('wrong bearer is rejected with 401 regardless of an otherwise-valid body', async () => {
  const server = await startServer();
  _setSendForTest(async () => ({ messages: [{ id: 'wamid.OK' }] }));
  try {
    const r = await post(server, validBody('evt-bad-bearer'), { bearer: 'not-the-secret' });
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { ok: false });
  } finally {
    _setSendForTest(null);
    server.close();
  }
});

test('an unknown event is acked as skipped, remembered, and never reaches the sender', async () => {
  const server = await startServer();
  let sendCalled = false;
  _setSendForTest(async () => { sendCalled = true; return { messages: [{ id: 'wamid.OK' }] }; });
  try {
    const first = await post(server, validBody('evt-unknown-1', 'some_future_event', {}));
    assert.equal(first.status, 200);
    assert.deepEqual(first.json, { ok: true, skipped: true });
    assert.equal(sendCalled, false, 'an unroutable event must never reach the sender');

    const second = await post(server, validBody('evt-unknown-1', 'some_future_event', {}));
    assert.equal(second.status, 200);
    assert.deepEqual(second.json, { ok: true, deduped: true },
      'a skipped event must still be remembered so it does not retry forever');
  } finally {
    _setSendForTest(null);
    server.close();
  }
});

test('a send that never resolves is cut off by the SLA guard as a 502 and is not remembered', async () => {
  const server = await startServer();
  _setSendForTest(() => new Promise(() => {})); // never settles
  try {
    const r = await post(server, validBody('evt-timeout-1'));
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, { ok: false });
  } finally {
    _setSendForTest(null);
    server.close();
  }
});
