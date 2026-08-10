// server/test/booster-client-execute.test.js
//
// executeApproval — the bot→booster call behind the process-approval confirm
// button. Contract (two-sided, built tonight — the booster implements the
// server half against this exact shape):
//   POST {BOOSTER_BASE_URL}/api/bot/approvals/execute
//   Authorization: Bearer BOOSTER_BOT_LOOKUP_SECRET (+ CF Access service-token
//   headers when configured), body { kind, lead_id }
//   success: 200 { ok: true } · failure: any other status with { error }
// NEVER throws: resolves { ok:true } | { ok:false, error } so the approval
// page can show a human reason and leave the token usable.
// fetch is stubbed — obviously fake fixtures only, this repo is public.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.BOOSTER_BASE_URL = 'http://booster.invalid';
process.env.BOOSTER_BOT_LOOKUP_SECRET = 'stub-bot-lookup-secret';
delete process.env.BOOSTER_CF_ACCESS_CLIENT_ID;
delete process.env.BOOSTER_CF_ACCESS_CLIENT_SECRET;

const { executeApproval, boosterLeadPanelUrl } = await import('../lib/booster-client.js');

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.BOOSTER_CF_ACCESS_CLIENT_ID;
  delete process.env.BOOSTER_CF_ACCESS_CLIENT_SECRET;
});

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const { status = 200, body = {} } = await handler(String(url), opts);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return calls;
}

test('executeApproval POSTs {kind, lead_id} to /api/bot/approvals/execute with the bot-lookup bearer and a timeout signal', async () => {
  const calls = stubFetch(async () => ({ status: 200, body: { ok: true } }));
  const r = await executeApproval({ kind: 'payment_verify', leadId: 'L-77' });

  assert.deepEqual(r, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://booster.invalid/api/bot/approvals/execute');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer stub-bot-lookup-secret');
  assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { kind: 'payment_verify', lead_id: 'L-77' });
  assert.ok(calls[0].opts.signal instanceof AbortSignal, 'a hung booster must not hold the page hostage');
});

test('executeApproval sends the CF Access service-token headers when configured — same as every bot→booster call', async () => {
  process.env.BOOSTER_CF_ACCESS_CLIENT_ID = 'stub-cf-id';
  process.env.BOOSTER_CF_ACCESS_CLIENT_SECRET = 'stub-cf-secret';
  const calls = stubFetch(async () => ({ status: 200, body: { ok: true } }));
  await executeApproval({ kind: 'work_confirm', leadId: 'L-88' });
  assert.equal(calls[0].opts.headers['CF-Access-Client-Id'], 'stub-cf-id');
  assert.equal(calls[0].opts.headers['CF-Access-Client-Secret'], 'stub-cf-secret');
});

test('a non-2xx carries the booster error code; no JSON falls back to http_<status>', async () => {
  stubFetch(async () => ({ status: 409, body: { error: 'wrong_status' } }));
  assert.deepEqual(await executeApproval({ kind: 'payment_verify', leadId: 'L-1' }),
    { ok: false, error: 'wrong_status' });

  stubFetch(async () => ({ status: 500, body: {} }));
  assert.deepEqual(await executeApproval({ kind: 'payment_verify', leadId: 'L-1' }),
    { ok: false, error: 'http_500' });
});

test('a 200 WITHOUT ok:true is not success — defensive against a half-built booster', async () => {
  stubFetch(async () => ({ status: 200, body: {} }));
  assert.deepEqual(await executeApproval({ kind: 'payment_verify', leadId: 'L-1' }),
    { ok: false, error: 'http_200' });
});

test('never throws: a network failure resolves {ok:false, error:network}, a timeout resolves {ok:false, error:timeout}', async () => {
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  assert.deepEqual(await executeApproval({ kind: 'payment_verify', leadId: 'L-1' }),
    { ok: false, error: 'network' });

  globalThis.fetch = async () => {
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    throw e;
  };
  assert.deepEqual(await executeApproval({ kind: 'payment_verify', leadId: 'L-1' }),
    { ok: false, error: 'timeout' });
});

test('boosterLeadPanelUrl builds the panel deep link off BOOSTER_BASE_URL', () => {
  assert.equal(boosterLeadPanelUrl('L-77'), 'http://booster.invalid/leads/L-77');
});
