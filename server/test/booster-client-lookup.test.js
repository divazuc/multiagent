// server/test/booster-client-lookup.test.js
//
// lookupBoosterLeadByPhone is the funnel's hottest call: the booster module's
// context provider runs it on EVERY inbound message, in front of the model.
// A bare fetch with no AbortSignal means a hung booster stalls the whole
// reply — and nothing rescues it, because /wa-inbound fast-acks so Meta never
// retries; the client simply waits. The call must therefore give up on its
// own and let the existing fail-soft paths take over.
// fetch is stubbed — obviously fake fixtures only, this repo is public.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.BOOSTER_BASE_URL = 'http://booster.invalid';
process.env.BOOSTER_BOT_LOOKUP_SECRET = 'stub-bot-lookup-secret';

const { lookupBoosterLeadByPhone, LOOKUP_TIMEOUT_MS } = await import('../lib/booster-client.js');

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

test('the status lookup carries an abort signal with a sub-2s budget', async () => {
  let init;
  globalThis.fetch = async (_url, opts) => {
    init = opts;
    return { ok: true, status: 200, json: async () => ({ lead_id: 'l1', status: 'awaiting_meeting' }) };
  };
  const lead = await lookupBoosterLeadByPhone('0521234567');
  assert.equal(lead.leadId, 'l1');
  assert.ok(init.signal, 'a reply-path fetch must never be unbounded');
  assert.equal(typeof init.signal.aborted, 'boolean');
  assert.ok(LOOKUP_TIMEOUT_MS > 0 && LOOKUP_TIMEOUT_MS <= 2000,
    `the budget sits in front of the model — ${LOOKUP_TIMEOUT_MS}ms must stay small`);
});

test('a booster that never answers is aborted rather than holding the reply open', async () => {
  let sawSignal = null;
  globalThis.fetch = (_url, opts) => new Promise((_resolve, reject) => {
    sawSignal = opts.signal ?? null;
    // A real fetch rejects on abort; the stub honours the signal the same way.
    // With no signal there is nothing to honour, so this request hangs
    // forever — exactly what a hung booster did to the reply.
    sawSignal?.addEventListener('abort', () => reject(sawSignal.reason ?? new Error('aborted')));
  });

  const started = Date.now();
  const watchdog = new Promise((resolve) => {
    const t = setTimeout(() => resolve('still-hanging'), 2500);
    t.unref?.();
  });
  const outcome = await Promise.race([
    lookupBoosterLeadByPhone('0521234567').then(() => 'resolved', () => 'aborted'),
    watchdog,
  ]);

  assert.ok(sawSignal, 'the request must carry an abort signal');
  assert.equal(outcome, 'aborted',
    'the lookup must give up on its own — the rejection is what the callers\' fail-soft paths already handle');
  assert.ok(Date.now() - started < 2500);
});

test('an unparseable phone still short-circuits before any fetch', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('must not be called'); };
  assert.equal(await lookupBoosterLeadByPhone('not-a-phone'), null);
  assert.equal(called, false);
});
