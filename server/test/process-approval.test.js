// server/test/process-approval.test.js
//
// Telegram one-tap PROCESS approvals (the generalization of the meeting
// approval): the booster's outbox pushes owner_approval_request →
//   · an approval record storing ONLY a SHA-256 hash of the token
//   · a Telegram message: kind-specific title, one-time /approve/<token>
//     link, and the booster panel line
//   · GET /approve/:token is side-effect-free (Telegram prefetches links)
//   · POST /approve/:token/confirm calls the booster's execute endpoint and
//     consumes the token ONLY on booster success — a failure leaves the token
//     usable for a retry
//   · missing Telegram env / unknown kind → the webhook still acks (the
//     booster's own server-side alert is the fallback); a TRANSIENT Telegram
//     failure 502s so the outbox retries
// Same seam conventions as meeting-approval.test.js — in-memory stores,
// stubbed Telegram fetch, stubbed booster execute; never a network call.
process.env.SUPABASE_URL = 'http://supabase.invalid';
process.env.SUPABASE_SERVICE_KEY = 'stub-service-key';
process.env.BOT_WEBHOOK_SECRET = 'test-secret-0123456789abcdef';
process.env.DIVAZ_BUSINESS_ID = 'biz-process-test';
// Panel line: with no BOOSTER_BASE_URL override the link must point at the
// real panel domain.
delete process.env.BOOSTER_BASE_URL;

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';

// Dynamic imports — booster-webhook.js -> wa-send.js -> supabase.js reads the
// env at module-evaluation time (same reasoning as booster-webhook.test.js).
const approvals = await import('../lib/approvals.js');
const proc = await import('../lib/process-approval.js');
const { default: boosterWebhookRouter, _setSendForTest } = await import('../routes/booster-webhook.js');
const { default: processApprovalRouter, _setExecuteApprovalForTest } = await import('../routes/process-approval.js');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function startServer() {
  const app = express();
  app.use(express.json());
  app.use(boosterWebhookRouter);
  app.use(processApprovalRouter);
  return new Promise((resolve) => { const server = app.listen(0, () => resolve(server)); });
}

async function postWebhook(server, body) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/booster-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.BOT_WEBHOOK_SECRET}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function hit(server, path, method = 'GET') {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  return { status: res.status, html: await res.text() };
}

const PAYMENT_PAYLOAD = {
  kind: 'payment_verify', lead_id: 'L-77', quote_number: 'DZ-2026-1042',
  client_name: 'דנה כהן', phone: '972521234567', amount: 2900, context: 'העברה בנקאית',
};
const WORK_PAYLOAD = {
  kind: 'work_confirm', lead_id: 'L-88', quote_number: 'DZ-2026-1043',
  client_name: 'יוסי לוי', phone: '0521111111',
};
const approvalEvent = (event_id, payload) => ({ event_id, event: 'owner_approval_request', payload });

const TG_ENV = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'PUBLIC_BASE_URL'];
const savedEnv = {};
let store;
test.beforeEach(() => {
  for (const k of TG_ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  process.env.TELEGRAM_BOT_TOKEN = 'tg-stub-token';
  process.env.TELEGRAM_CHAT_ID = '12345';
  process.env.PUBLIC_BASE_URL = 'https://bot.example';
  store = { events: [] };
  proc._setDbForTest(store);
});
test.afterEach(() => {
  for (const k of TG_ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  proc._setDbForTest(null);
  approvals._setTelegramFetchForTest(null);
  _setExecuteApprovalForTest(null);
  _setSendForTest(null);
});

function stubTelegram() {
  const tg = [];
  approvals._setTelegramFetchForTest(async (url, init) => { tg.push({ url, body: JSON.parse(init.body) }); return { ok: true }; });
  return tg;
}

// ── The webhook event ────────────────────────────────────────────────────────

test('payment_verify: record with hash-only token + a Telegram message with the title, details, one-time link, and panel line', async () => {
  const tg = stubTelegram();
  const server = await startServer();
  try {
    const r = await postWebhook(server, approvalEvent('evt-pv-1', PAYMENT_PAYLOAD));
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });

    assert.equal(store.events.length, 1);
    const row = store.events[0];
    assert.equal(row.business_id, 'biz-process-test');
    assert.equal(row.module_key, 'booster');
    assert.equal(row.event_type, 'process_approval');
    assert.equal(row.detail.status, 'pending');
    assert.equal(row.detail.kind, 'payment_verify');
    assert.equal(row.detail.lead_id, 'L-77');
    assert.equal(row.detail.quote_number, 'DZ-2026-1042');
    assert.equal(row.detail.client_name, 'דנה כהן');
    assert.equal(row.detail.phone, '0521234567', 'stored in the normalized 05… form');
    assert.equal(row.detail.amount, 2900);
    assert.equal(row.detail.context, 'העברה בנקאית');

    assert.equal(tg.length, 1);
    assert.ok(tg[0].url.includes('/bottg-stub-token/sendMessage'));
    assert.equal(tg[0].body.chat_id, '12345');
    const text = tg[0].body.text;
    assert.match(text, /^💰 אסמכתת תשלום ממתינה לאישור\n/);
    assert.match(text, /לקוח: דנה כהן/);
    assert.match(text, /הזמנה: DZ-2026-1042/);
    assert.match(text, /סכום: ₪2900/);
    assert.match(text, /אישור: https:\/\/bot\.example\/approve\/[A-Za-z0-9_-]+/);
    assert.match(text, /פאנל: https:\/\/booster\.divdev\.co\/leads\/L-77/);
    const token = text.match(/\/approve\/([A-Za-z0-9_-]+)/)[1];
    assert.equal(row.detail.token_hash, sha256(token), 'the link carries the exact token whose hash was stored');
    assert.ok(!JSON.stringify(row).includes(token), 'the raw token must never be persisted');
  } finally {
    server.close();
  }
});

test('work_confirm: its own title, client + quote, no amount line', async () => {
  const tg = stubTelegram();
  const server = await startServer();
  try {
    const r = await postWebhook(server, approvalEvent('evt-wc-1', WORK_PAYLOAD));
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    assert.equal(store.events[0].detail.kind, 'work_confirm');
    const text = tg[0].body.text;
    assert.match(text, /^📄 הלקוח סיים לערוך תכנים — לאשר התחלת עבודה\?\n/);
    assert.match(text, /לקוח: יוסי לוי/);
    assert.match(text, /הזמנה: DZ-2026-1043/);
    assert.doesNotMatch(text, /סכום/);
    assert.match(text, /פאנל: https:\/\/booster\.divdev\.co\/leads\/L-88/);
  } finally {
    server.close();
  }
});

test('Telegram env missing: the webhook still 200s (skipped), no record — the booster-side alert is the fallback', async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  const server = await startServer();
  try {
    const r = await postWebhook(server, approvalEvent('evt-noenv-1', PAYMENT_PAYLOAD));
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, skipped: true });
    assert.equal(store.events.length, 0, 'a token nobody will ever receive is not created');
  } finally {
    server.close();
  }
});

test('an unknown kind is logged and acked without a record (forward-compat), and is remembered', async () => {
  const tg = stubTelegram();
  const server = await startServer();
  try {
    const first = await postWebhook(server, approvalEvent('evt-unk-1', { ...PAYMENT_PAYLOAD, kind: 'refund_everything' }));
    assert.equal(first.status, 200);
    assert.deepEqual(first.json, { ok: true, skipped: true });
    assert.equal(store.events.length, 0);
    assert.equal(tg.length, 0);

    const second = await postWebhook(server, approvalEvent('evt-unk-1', { ...PAYMENT_PAYLOAD, kind: 'refund_everything' }));
    assert.deepEqual(second.json, { ok: true, deduped: true },
      'a skipped event must still be remembered so it does not retry forever');
  } finally {
    server.close();
  }
});

test('a transient Telegram failure 502s and is NOT remembered — the outbox retry then succeeds', async () => {
  approvals._setTelegramFetchForTest(async () => { throw new Error('telegram down'); });
  const server = await startServer();
  try {
    const failed = await postWebhook(server, approvalEvent('evt-tgfail-1', PAYMENT_PAYLOAD));
    assert.equal(failed.status, 502);
    assert.deepEqual(failed.json, { ok: false });

    const tg = stubTelegram(); // Telegram recovers
    const retried = await postWebhook(server, approvalEvent('evt-tgfail-1', PAYMENT_PAYLOAD));
    assert.equal(retried.status, 200);
    assert.deepEqual(retried.json, { ok: true }, 'must not have been deduped — the failed attempt was never remembered');
    assert.equal(tg.length, 1, 'the retry really delivered');
  } finally {
    server.close();
  }
});

// ── The public routes ────────────────────────────────────────────────────────

// Seed through the webhook so the page tests exercise the exact records
// production writes; returns the raw token from the Telegram message.
async function seedViaWebhook(server, payload, eventId = `evt-seed-${Math.random()}`) {
  const tg = stubTelegram();
  const r = await postWebhook(server, approvalEvent(eventId, payload));
  assert.equal(r.status, 200);
  approvals._setTelegramFetchForTest(null);
  return tg[0].body.text.match(/\/approve\/([A-Za-z0-9_-]+)/)[1];
}

test('GET /approve/:token shows the request with ONE confirm button + panel link and causes zero side effects', async () => {
  const server = await startServer();
  const executed = [];
  _setExecuteApprovalForTest(async (args) => { executed.push(args); return { ok: true }; });
  try {
    const token = await seedViaWebhook(server, PAYMENT_PAYLOAD);
    const r = await hit(server, `/approve/${token}`);
    assert.equal(r.status, 200);
    assert.match(r.html, /dir="rtl"/);
    assert.match(r.html, /💰 אסמכתת תשלום ממתינה לאישור/);
    assert.match(r.html, /דנה כהן/);
    assert.match(r.html, /DZ-2026-1042/);
    assert.match(r.html, /0521234567/);
    assert.match(r.html, /₪2900/);
    assert.match(r.html, /העברה בנקאית/);
    assert.match(r.html, new RegExp(`action="/approve/${token}/confirm"`));
    assert.match(r.html, /אישור תשלום ✓/);
    assert.match(r.html, /https:\/\/booster\.divdev\.co\/leads\/L-77/);
    // Telegram prefetches every link it shows — a GET with side effects would
    // approve processes nobody tapped.
    assert.equal(executed.length, 0);
    assert.equal(store.events[0].detail.status, 'pending');
  } finally {
    server.close();
  }
});

test('GET for work_confirm renders its title and button', async () => {
  const server = await startServer();
  try {
    const token = await seedViaWebhook(server, WORK_PAYLOAD);
    const r = await hit(server, `/approve/${token}`);
    assert.equal(r.status, 200);
    assert.match(r.html, /📄 הלקוח סיים לערוך תכנים — לאשר התחלת עבודה\?/);
    assert.match(r.html, /אישור התחלת עבודה ✓/);
    assert.doesNotMatch(r.html, /סכום/);
  } finally {
    server.close();
  }
});

test('confirm happy path: the booster is called with {kind, leadId}, the record is consumed, the page says the panel updated', async () => {
  const server = await startServer();
  const executed = [];
  _setExecuteApprovalForTest(async (args) => { executed.push(args); return { ok: true }; });
  try {
    const token = await seedViaWebhook(server, PAYMENT_PAYLOAD);
    const r = await hit(server, `/approve/${token}/confirm`, 'POST');
    assert.equal(r.status, 200);
    assert.match(r.html, /אושר ✓/);
    assert.match(r.html, /הפאנל עודכן/);
    assert.deepEqual(executed, [{ kind: 'payment_verify', leadId: 'L-77' }]);
    assert.equal(store.events[0].detail.status, 'approved');
    assert.ok(store.events[0].detail.consumed_at);
  } finally {
    server.close();
  }
});

test('a booster failure shows a human reason, does NOT consume — the same token retries and then succeeds', async () => {
  const server = await startServer();
  const executed = [];
  _setExecuteApprovalForTest(async (args) => { executed.push(args); return { ok: false, error: 'timeout' }; });
  try {
    const token = await seedViaWebhook(server, PAYMENT_PAYLOAD);
    const failed = await hit(server, `/approve/${token}/confirm`, 'POST');
    assert.equal(failed.status, 502);
    assert.match(failed.html, /הפעולה לא הושלמה/);
    assert.match(failed.html, /הבוסטר לא הגיב בזמן/);
    assert.match(failed.html, new RegExp(`action="/approve/${token}/confirm"`), 'the retry is one more tap on the same page');
    assert.equal(store.events[0].detail.status, 'pending', 'a failed execute must NOT consume the token');

    _setExecuteApprovalForTest(async (args) => { executed.push(args); return { ok: true }; });
    const retried = await hit(server, `/approve/${token}/confirm`, 'POST');
    assert.equal(retried.status, 200);
    assert.match(retried.html, /אושר ✓/);
    assert.equal(store.events[0].detail.status, 'approved');
    assert.equal(executed.length, 2);
  } finally {
    server.close();
  }
});

test('a second confirm after success is "כבר טופל" and the booster is not called again', async () => {
  const server = await startServer();
  const executed = [];
  _setExecuteApprovalForTest(async (args) => { executed.push(args); return { ok: true }; });
  try {
    const token = await seedViaWebhook(server, WORK_PAYLOAD);
    await hit(server, `/approve/${token}/confirm`, 'POST');
    const again = await hit(server, `/approve/${token}/confirm`, 'POST');
    assert.equal(again.status, 200);
    assert.match(again.html, /כבר טופל/);
    assert.equal(executed.length, 1, 'single-use: the second tap must never re-execute');
    const viaGet = await hit(server, `/approve/${token}`);
    assert.match(viaGet.html, /כבר טופל/, 'the GET page agrees once consumed');
  } finally {
    server.close();
  }
});

test('an expired token (>7 days) gets the 404-style page from both GET and POST, with zero side effects', async () => {
  const server = await startServer();
  const executed = [];
  _setExecuteApprovalForTest(async (args) => { executed.push(args); return { ok: true }; });
  try {
    const token = await seedViaWebhook(server, PAYMENT_PAYLOAD);
    store.events[0].created_at = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    for (const [path, method] of [[`/approve/${token}`, 'GET'], [`/approve/${token}/confirm`, 'POST']]) {
      const r = await hit(server, path, method);
      assert.equal(r.status, 404, `${method} ${path} must 404`);
      assert.match(r.html, /הקישור לא בתוקף/);
    }
    assert.equal(executed.length, 0);
    assert.equal(store.events[0].detail.status, 'pending', 'expiry never rewrites the record');
    // Just inside the window the same token still works.
    store.events[0].created_at = new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString();
    const ok = await hit(server, `/approve/${token}`);
    assert.equal(ok.status, 200);
  } finally {
    server.close();
  }
});

test('an invalid token gets the neutral 404-style Hebrew page and never reaches the booster', async () => {
  const server = await startServer();
  const executed = [];
  _setExecuteApprovalForTest(async (args) => { executed.push(args); return { ok: true }; });
  try {
    for (const [path, method] of [
      ['/approve/definitely-not-a-real-token-aaaa', 'GET'],
      ['/approve/definitely-not-a-real-token-aaaa/confirm', 'POST'],
      ['/approve/%2e%2e', 'GET'],
    ]) {
      const r = await hit(server, path, method);
      assert.equal(r.status, 404, `${method} ${path} must 404`);
    }
    assert.equal(executed.length, 0);
  } finally {
    server.close();
  }
});
