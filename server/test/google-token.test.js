// lib/google-token.js — the platform's divazuc Google identity: refresh-token
// → access-token exchange, cached with the calendar module's -60s margin.
import test from 'node:test';
import assert from 'node:assert/strict';

const gt = await import('../lib/google-token.js');
const { googleSheetAuthConfigured, getGoogleAccessToken } = gt;

const ENV = {
  GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_REFRESH_TOKEN_DIVAZUC: 'refresh-token-divazuc',
};

function armEnv() { Object.assign(process.env, ENV); }
function clearEnv() { for (const k of Object.keys(ENV)) delete process.env[k]; }

const okResponse = (token = 'access-1', expires = 3600) => ({
  ok: true,
  async json() { return { access_token: token, expires_in: expires, token_type: 'Bearer' }; },
});

test.afterEach(() => {
  gt._setFetchForTest(null); // also clears the cache
  clearEnv();
});

test('googleSheetAuthConfigured needs all three env names', () => {
  clearEnv();
  assert.equal(googleSheetAuthConfigured(), false);
  armEnv();
  assert.equal(googleSheetAuthConfigured(), true);
  delete process.env.GOOGLE_REFRESH_TOKEN_DIVAZUC;
  assert.equal(googleSheetAuthConfigured(), false);
});

test('exchanges the divazuc refresh token at the Google token endpoint', async () => {
  armEnv();
  const calls = [];
  gt._setFetchForTest(async (url, opts) => { calls.push({ url, opts }); return okResponse(); });

  const token = await getGoogleAccessToken();
  assert.equal(token, 'access-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  const body = calls[0].opts.body.toString();
  assert.ok(body.includes('grant_type=refresh_token'));
  assert.ok(body.includes('refresh_token=refresh-token-divazuc'));
});

test('caches the access token and refreshes only after expiry', async () => {
  armEnv();
  let n = 0;
  gt._setFetchForTest(async () => okResponse(`access-${++n}`, 3600));

  const t0 = Date.now();
  assert.equal(await getGoogleAccessToken({ now: t0 }), 'access-1');
  // 30 minutes later — still inside expires_in-60s
  assert.equal(await getGoogleAccessToken({ now: t0 + 30 * 60_000 }), 'access-1');
  assert.equal(n, 1);
  // past the -60s margin — a fresh exchange
  assert.equal(await getGoogleAccessToken({ now: t0 + 3541 * 1000 }), 'access-2');
  assert.equal(n, 2);
});

test('throws with a readable error on a refused refresh (no secrets in message)', async () => {
  armEnv();
  gt._setFetchForTest(async () => ({ ok: false, status: 400, async json() { return { error: 'invalid_grant' }; } }));
  await assert.rejects(() => getGoogleAccessToken(), /invalid_grant/);
});

test('throws immediately when the env is not configured', async () => {
  clearEnv();
  gt._setFetchForTest(async () => { throw new Error('must not be called'); });
  await assert.rejects(() => getGoogleAccessToken(), /GOOGLE_REFRESH_TOKEN_DIVAZUC/);
});
