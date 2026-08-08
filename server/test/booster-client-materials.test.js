// server/test/booster-client-materials.test.js
//
// T5 (funnel track 1) — declareMaterialsDone: the client said "סיימתי" in
// chat, the bot tells the booster (which owns the materials_declared
// transition + Diva's Telegram ping). Contract (plan "חוזים חדשים"):
//   POST /api/leads/{id}/materials-declared, bearer BOT_LOOKUP_SECRET,
//   body {note? ≤2000} → 200 {ok, status} · already declared → {ok,
//   already:true} · 409 wrong_status · 401/404.
// Same shape discipline as forwardPaymentProof; fetch is stubbed — obviously
// fake fixtures only, this repo is public.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.BOOSTER_BASE_URL = 'http://booster.invalid';
process.env.BOOSTER_BOT_LOOKUP_SECRET = 'stub-bot-lookup-secret';
delete process.env.BOOSTER_CF_ACCESS_CLIENT_ID;
delete process.env.BOOSTER_CF_ACCESS_CLIENT_SECRET;

const { declareMaterialsDone } = await import('../lib/booster-client.js');

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const { status = 200, body = {} } = await handler(String(url), opts);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  return calls;
}

test('declareMaterialsDone POSTs the note to /api/leads/{id}/materials-declared with the bot-lookup bearer', async () => {
  const calls = stubFetch(async () => ({ status: 200, body: { ok: true, status: 'materials_declared' } }));
  const r = await declareMaterialsDone({ leadId: 'lead-1', note: 'העליתי הכל לתיקייה' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://booster.invalid/api/leads/lead-1/materials-declared');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer stub-bot-lookup-secret');
  assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { note: 'העליתי הכל לתיקייה' });
  assert.deepEqual(r, { already: false, status: 'materials_declared' });
});

test('declareMaterialsDone omits the note key when there is none and truncates an over-long note to 2000 chars', async () => {
  const calls = stubFetch(async () => ({ status: 200, body: { ok: true, status: 'materials_declared' } }));
  await declareMaterialsDone({ leadId: 'lead-2' });
  assert.deepEqual(JSON.parse(calls[0].opts.body), {}, 'no note → empty body, never note:null');

  await declareMaterialsDone({ leadId: 'lead-2', note: 'א'.repeat(3000) });
  const sent = JSON.parse(calls[1].opts.body);
  assert.equal(sent.note.length, 2000, 'the contract caps note at 2000 — truncate rather than 400');
});

test('declareMaterialsDone surfaces the idempotent already:true 200', async () => {
  stubFetch(async () => ({ status: 200, body: { ok: true, already: true } }));
  const r = await declareMaterialsDone({ leadId: 'lead-3' });
  assert.equal(r.already, true);
});

test('declareMaterialsDone throws on a non-2xx (409 wrong_status) so the caller can answer honestly', async () => {
  stubFetch(async () => ({ status: 409, body: { error: 'wrong_status' } }));
  await assert.rejects(
    () => declareMaterialsDone({ leadId: 'lead-4' }),
    /materials-declared 409 wrong_status/);
});
