// server/test/booster-env.test.js
//
// Deploy visibility (plan T17): the express funnel reads its booster
// credentials — and the tenant the funnel belongs to — from the environment.
// A missed key degrades the funnel SILENTLY: no meeting notes, no slot offer,
// or a 403 on every booster call. The boot-time check turns that into one
// obvious line in the startup log.
// Hermetic by construction: every case passes an explicit env object, so the
// real process env is never read or mutated here.
import test from 'node:test';
import assert from 'node:assert/strict';

const { REQUIRED_BOOSTER_ENV, missingBoosterEnv, warnOnIncompleteBoosterEnv } =
  await import('../lib/booster-client.js');

const complete = {
  BOT_WEBHOOK_SECRET: 'x',
  BOOSTER_LEAD_INTAKE_SECRET: 'x',
  BOOSTER_BOT_LOOKUP_SECRET: 'x',
  DIVAZ_BUSINESS_ID: '00000000-0000-0000-0000-000000000000',
};

test('a complete booster env reports nothing missing', () => {
  assert.deepEqual(missingBoosterEnv(complete), []);
  // The Cloudflare Access pair is production-only — absent is fine.
  assert.deepEqual(missingBoosterEnv({ ...complete, BOOSTER_BASE_URL: 'http://booster.invalid' }), []);
});

test('DIVAZ_BUSINESS_ID is required — the silent one that disables meeting notes and the slot offer', () => {
  assert.ok(REQUIRED_BOOSTER_ENV.includes('DIVAZ_BUSINESS_ID'));
  const env = { ...complete };
  delete env.DIVAZ_BUSINESS_ID;
  assert.deepEqual(missingBoosterEnv(env), ['DIVAZ_BUSINESS_ID']);
});

test('every missing key is listed, not just the first', () => {
  assert.deepEqual(missingBoosterEnv({}).sort(), [...REQUIRED_BOOSTER_ENV].sort());
});

test('half a Cloudflare Access pair counts as missing — the headers are dropped and every call 403s', () => {
  assert.deepEqual(missingBoosterEnv({ ...complete, BOOSTER_CF_ACCESS_CLIENT_ID: 'id' }),
    ['BOOSTER_CF_ACCESS_CLIENT_SECRET']);
  assert.deepEqual(missingBoosterEnv({ ...complete, BOOSTER_CF_ACCESS_CLIENT_SECRET: 's' }),
    ['BOOSTER_CF_ACCESS_CLIENT_ID']);
  assert.deepEqual(missingBoosterEnv({ ...complete, BOOSTER_CF_ACCESS_CLIENT_ID: 'id', BOOSTER_CF_ACCESS_CLIENT_SECRET: 's' }), []);
});

test('warnOnIncompleteBoosterEnv warns once naming the keys, and stays silent when complete', () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const missing = warnOnIncompleteBoosterEnv({ BOT_WEBHOOK_SECRET: 'x' });
    assert.ok(missing.includes('DIVAZ_BUSINESS_ID'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /DIVAZ_BUSINESS_ID/);
    assert.match(warnings[0], /BOOSTER_BOT_LOOKUP_SECRET/);

    warnOnIncompleteBoosterEnv(complete);
    assert.equal(warnings.length, 1, 'a complete env must not add startup noise');
  } finally {
    console.warn = realWarn;
  }
});
