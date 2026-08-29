import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.MODULE_SECRETS_KEY ??= crypto.randomBytes(32).toString('base64');
process.env.BOOSTER_BASE_URL = 'http://booster.invalid';
process.env.BOOSTER_BOT_LOOKUP_SECRET = 'stub-bot-lookup-secret';

const { lookupBoosterLeadByPhone, LOOKUP_TIMEOUT_MS } = await import('../lib/booster-client.js');
const booster = (await import('../lib/modules/booster.js')).default;
const { _setBoosterClientForTest, _clearStatusCacheForTest, _seedStatusCacheForTest } =
  await import('../lib/modules/booster.js');
const { tentativeText } = await import('../lib/modules/calendar/index.js');

// Owner, 2026-08-29 (Diva Ost E2E): four consecutive "status lookup failed —
// timeout" lines. Each one dropped the WHOLE booster context — the client's
// known name and her stage — so the bot asked a signed client "מה שמך המלא?"
// and answered generically. The lookup is now retried once, and when it still
// fails the last lead we DID fetch keeps driving the context (stale beats
// nothing); a lead the bot itself just created seeds that cache immediately.

const BIZ = { id: 'b1', name: 'Diva Ost' };
const ROW = { business_id: 'b1', module_key: 'booster', enabled: true, status: 'connected', secrets: {}, settings: {} };
const SENDER = { session_id: '0528250088', profile_name: 'Diva' };
const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
  _setBoosterClientForTest(null);
  _clearStatusCacheForTest();
});

test('the lookup budget is 2s — the most the reply path may spend, and enough for a cold booster function', () => {
  assert.equal(LOOKUP_TIMEOUT_MS, 2000);
});

test('a timed-out lookup is retried once, and the second answer is returned', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw timeoutError();
    return { ok: true, status: 200, json: async () => ({ lead_id: 'l1', name: 'Diva', status: 'awaiting_meeting' }) };
  };
  const lead = await lookupBoosterLeadByPhone('0528250088');
  assert.equal(calls, 2);
  assert.equal(lead.leadId, 'l1');
  assert.equal(lead.name, 'Diva');
});

test('two timeouts in a row still throw — the caller\'s fail-soft path decides, not an endless loop', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw timeoutError(); };
  await assert.rejects(() => lookupBoosterLeadByPhone('0528250088'));
  assert.equal(calls, 2);
});

test('a non-timeout failure is not retried', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 500, json: async () => ({}) }; };
  await assert.rejects(() => lookupBoosterLeadByPhone('0528250088'));
  assert.equal(calls, 1);
});

test('stale-while-error: when the fresh lookup fails, the last lead we fetched still drives the context', async () => {
  _seedStatusCacheForTest(SENDER.session_id, { leadId: 'l1', name: 'Diva', status: 'awaiting_meeting' }, Date.now() - 5 * 60_000);
  _setBoosterClientForTest({ lookupBoosterLeadByPhone: async () => { throw timeoutError(); } });
  const ctx = await booster.contextProvider(BIZ, ROW, SENDER);
  assert.ok(ctx.includes('שם הלקוח ידוע'), 'the known-name block survives the outage');
  assert.ok(ctx.includes('Diva'));
  assert.ok(ctx.includes('השלב הנוכחי'), 'and so does the stage guidance');
});

test('the stale fallback has a horizon — a lead last seen a day ago is not served', async () => {
  _seedStatusCacheForTest(SENDER.session_id, { leadId: 'l1', name: 'Diva', status: 'awaiting_meeting' }, Date.now() - 26 * 60 * 60_000);
  _setBoosterClientForTest({ lookupBoosterLeadByPhone: async () => { throw timeoutError(); } });
  const ctx = await booster.contextProvider(BIZ, ROW, SENDER);
  assert.ok(!ctx.includes('שם הלקוח ידוע'));
});

test('a lead the bot just created seeds the cache — the next turn knows the name without any lookup', async () => {
  _setBoosterClientForTest({
    createBoosterLead: async ({ name }) => ({ leadId: 'l9', name, linkUrl: 'https://booster.invalid/q/tok', created: true, validDays: 14, status: 'lead', packageId: 'mini' }),
    lookupBoosterLeadByPhone: async () => { throw timeoutError(); },
  });
  const out = await booster.actions.create_quote_lead.handler(BIZ, ROW, { package_id: 'mini' }, SENDER);
  assert.ok(out.confirmationText.includes('https://booster.invalid/q/tok'));
  const ctx = await booster.contextProvider(BIZ, ROW, SENDER);
  assert.ok(ctx.includes('שם הלקוח ידוע'), 'seeded from the create response, not from a lookup');
  assert.ok(ctx.includes('Diva'));
});

// Owner, 2026-08-29: while the owner approves, the client should hear that the
// slot is with HER and that the bot is coming right back — in the tenant's
// owner name (calendar settings), never a hard-coded one.
test('tentativeText names the owner from settings and promises to come back; neutral without a name', () => {
  const named = tentativeText('דיוה');
  assert.match(named, /דיוה/);
  assert.match(named, /אחזור אלי?ך|חוזר/);
  assert.match(named, /זימון למייל/);
  const neutral = tentativeText('');
  assert.doesNotMatch(neutral, /דיוה|מאמנ/);
  assert.match(neutral, /לאישור/);
});
