// Cost-efficiency pass (2026-08-12) — integration-shaped tests against the
// real runConversation entry point (the same seam every other conversation.js
// test file uses), covering:
//   item 1 — usage instrumentation lands on the result as model_usage/
//            model_usage_total, with real fields from the mocked response.
//   item 2 — the reply prompt's system is [stable(cached), dynamic]; the
//            stable block is byte-identical across two turns of the same
//            business (the cache-hit precondition the task asks for).
//   item 3 — the KB block lives in the dynamic tail, never the cached
//            stable block; empty retrieval source falls back to faq_summary.
//   item 4 — a confident direct-KB hit costs zero model calls.
//   item 5 — persona.conversation_model overrides MODEL for every call this
//            turn makes; an invalid override falls back to the default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runConversation, _setMessagesCreateForTest } from '../agents/conversation.js';

const INTENT_OK = JSON.stringify({
  detected_intent: 'info_seeking', sentiment: 'neutral', language: 'hebrew',
  urgency: 'low', cta_decision: 'clarify', qualification_complete: false,
  missing_fields: [], escalate: false, escalation_reason: null, qualification_progress: {},
});

// No question mark, short — clears validate() on the first pass (no rewrite
// call), which keeps the per-test call count/usage-entry count predictable.
const REPLY_OK = 'מעולה, אשמח לעזור עם כל שאלה נוספת בהמשך.';

function usage(overrides = {}) {
  return { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...overrides };
}

function baseContext(overrides = {}) {
  return {
    business_id: 'b1',
    business_profile: {
      business_name: 'עסק לדוגמה', agent_mode: 'support', cta_goal: 'book_call',
      knowledge: {},
    },
    persona: {}, guardrails: {}, hebrew_patterns: {},
    conversation_history: [], missing_qualification_data: [],
    current_stage: 'greeting', qualification_progress: {},
    ...overrides,
  };
}

test.afterEach(() => _setMessagesCreateForTest(null));

// ── item 2: cache block structure ───────────────────────────────────────────

test('the reply system is [stable(cached), dynamic]; only the stable block carries cache_control', async () => {
  const captured = [];
  let n = 0;
  _setMessagesCreateForTest(async (params) => {
    captured.push(params);
    if (++n === 1) return { content: [{ text: INTENT_OK }], usage: usage() };
    return { content: [{ text: REPLY_OK }], usage: usage() };
  });

  await runConversation({ message: 'מה שעות הפעילות?', session_id: 's1', context: baseContext() });

  const system = captured[1].system;
  assert.ok(Array.isArray(system), 'system must be an array of blocks, not a plain string');
  assert.equal(system.length, 2);
  assert.deepEqual(system[0].cache_control, { type: 'ephemeral' });
  assert.equal(system[1].cache_control, undefined, 'the dynamic tail must not be cached');
});

test('the stable block is byte-identical across two turns of the same business (cache-hit precondition)', async () => {
  const captured = [];
  _setMessagesCreateForTest(async (params) => {
    captured.push(params);
    return captured.length % 2 === 1
      ? { content: [{ text: INTENT_OK }], usage: usage() }
      : { content: [{ text: REPLY_OK }], usage: usage() };
  });

  const ctx = baseContext();
  await runConversation({ message: 'מה שעות הפעילות?', session_id: 's1', context: ctx });
  const firstStable = captured[1].system[0].text;

  // A different message AND a non-empty history — everything a real second
  // turn would vary — must still produce the identical stable prefix.
  await runConversation({
    message: 'ומה לגבי חניה?', session_id: 's1',
    context: baseContext({ conversation_history: [{ role: 'user', content: 'מה שעות הפעילות?' }, { role: 'assistant', content: REPLY_OK }] }),
  });
  const secondStable = captured[3].system[0].text;

  assert.equal(firstStable, secondStable, 'the stable prefix must be byte-identical turn to turn — this is what makes it cacheable');
});

// ── item 3: KB retrieval in the dynamic tail ────────────────────────────────

test('a retrieved KB row lands in the dynamic tail, never the cached stable block', async () => {
  const captured = [];
  let n = 0;
  _setMessagesCreateForTest(async (params) => {
    captured.push(params);
    if (++n === 1) return { content: [{ text: INTENT_OK }], usage: usage() };
    return { content: [{ text: REPLY_OK }], usage: usage() };
  });

  // Deliberately NOT the exact stored question — a single word that overlaps
  // it. Scores > 0 (retrieval must surface it) but well under item 4's
  // direct-match bar (no near-exact match, score below the margin floor), so
  // this exercises the RETRIEVAL path, not the direct-KB short-circuit.
  await runConversation({
    message: 'שעות', session_id: 's1',
    context: baseContext({
      business_profile: {
        business_name: 'עסק לדוגמה', agent_mode: 'support', cta_goal: 'book_call',
        knowledge: { items: [
          { question: 'מה שעות הפעילות שלכם?', answer: 'פתוחים א-ה 9-18.', category: 'שעות' },
        ] },
      },
    }),
  });

  assert.equal(captured.length, 2, 'the model path (intent + reply) must have been taken, not the direct-KB short-circuit');
  const [stable, dynamic] = captured[1].system;
  assert.doesNotMatch(stable.text, /פתוחים א-ה 9-18/, 'the retrieved answer must not leak into the cached block');
  assert.match(dynamic.text, /פתוחים א-ה 9-18/, 'the retrieved answer belongs in the dynamic tail');
  assert.match(dynamic.text, /אם אין במידע תשובה — אל תמציא/);
});

test('business_profile.knowledge is stripped from the stable block\'s JSON dump entirely', async () => {
  const captured = [];
  let n = 0;
  _setMessagesCreateForTest(async (params) => {
    captured.push(params);
    if (++n === 1) return { content: [{ text: INTENT_OK }], usage: usage() };
    return { content: [{ text: REPLY_OK }], usage: usage() };
  });

  await runConversation({
    message: 'מה שעות הפעילות שלכם?', session_id: 's1',
    context: baseContext({
      business_profile: {
        business_name: 'עסק לדוגמה', agent_mode: 'support', cta_goal: 'book_call',
        knowledge: { faq_summary: 'A HUGE UNRELATED FAQ DUMP THAT MUST NOT BE CACHED VERBATIM', items: [] },
      },
    }),
  });

  assert.doesNotMatch(captured[1].system[0].text, /HUGE UNRELATED FAQ DUMP/,
    'knowledge must never appear in the JSON-stringified business profile inside the stable block');
});

test('no knowledge_items rows falls back to the full faq_summary text in the dynamic tail (fail-soft)', async () => {
  const captured = [];
  let n = 0;
  _setMessagesCreateForTest(async (params) => {
    captured.push(params);
    if (++n === 1) return { content: [{ text: INTENT_OK }], usage: usage() };
    return { content: [{ text: REPLY_OK }], usage: usage() };
  });

  await runConversation({
    message: 'משהו שלא קשור לשום דבר', session_id: 's1',
    context: baseContext({
      business_profile: {
        business_name: 'עסק לדוגמה', agent_mode: 'support', cta_goal: 'book_call',
        knowledge: { faq_summary: 'התשובה הכללית שלנו לכל השאלות', items: [] },
      },
    }),
  });

  assert.match(captured[1].system[1].text, /התשובה הכללית שלנו לכל השאלות/);
});

// ── item 1: usage instrumentation ───────────────────────────────────────────

test('model_usage carries one real entry per Anthropic call, with the mocked usage fields', async () => {
  let n = 0;
  _setMessagesCreateForTest(async () => {
    n += 1;
    if (n === 1) return { content: [{ text: INTENT_OK }], usage: usage({ input_tokens: 300, output_tokens: 40 }) };
    return { content: [{ text: REPLY_OK }], usage: usage({ input_tokens: 1500, output_tokens: 90, cache_read_input_tokens: 1200 }) };
  });

  const out = await runConversation({ message: 'מה שעות הפעילות?', session_id: 's1', context: baseContext() });

  assert.equal(out.status, 'success');
  assert.equal(out.result.model_usage.length, 2, 'one entry per Anthropic call (intent + reply)');
  assert.equal(out.result.model_usage[0].input_tokens, 300);
  assert.equal(out.result.model_usage[1].cache_read_input_tokens, 1200);
  assert.equal(out.result.model_usage_total.calls, 2);
  assert.equal(out.result.model_usage_total.input_tokens, 1800);
  assert.ok(out.result.model_usage_total.cost_usd > 0);
});

// ── item 4: direct-KB costs zero model calls ────────────────────────────────

test('a confident direct-KB hit answers without ANY model call', async () => {
  let calls = 0;
  _setMessagesCreateForTest(async () => { calls += 1; throw new Error('must never be called'); });

  const out = await runConversation({
    message: 'מה שעות הפעילות שלכם?', session_id: 's1',
    context: baseContext({
      business_profile: {
        business_name: 'עסק לדוגמה', agent_mode: 'support', cta_goal: 'book_call',
        knowledge: { items: [
          { question: 'מה שעות הפעילות שלכם?', answer: 'פתוחים א-ה 9-18.', category: 'שעות' },
        ] },
      },
    }),
  });

  assert.equal(calls, 0, 'zero model calls');
  assert.equal(out.status, 'success');
  assert.equal(out.result.response, 'פתוחים א-ה 9-18.');
  assert.equal(out.result.kb_direct.matched, true);
  assert.equal(out.result.kb_direct.question, 'מה שעות הפעילות שלכם?');
  assert.deepEqual(out.result.model_usage, []);
});

test('a follow-up-shaped turn (non-trivial history) never takes the direct-KB path, even for an exact question', async () => {
  let n = 0;
  _setMessagesCreateForTest(async () => {
    n += 1;
    return n === 1
      ? { content: [{ text: INTENT_OK }], usage: usage() }
      : { content: [{ text: REPLY_OK }], usage: usage() };
  });

  const out = await runConversation({
    message: 'מה שעות הפעילות שלכם?', session_id: 's1',
    context: baseContext({
      conversation_history: [{ role: 'user', content: 'היי' }, { role: 'assistant', content: 'שלום, איך אפשר לעזור?' }],
      business_profile: {
        business_name: 'עסק לדוגמה', agent_mode: 'support', cta_goal: 'book_call',
        knowledge: { items: [
          { question: 'מה שעות הפעילות שלכם?', answer: 'פתוחים א-ה 9-18.', category: 'שעות' },
        ] },
      },
    }),
  });

  assert.equal(n, 2, 'the model path was taken (intent + reply)');
  assert.equal(out.result.kb_direct, undefined);
});

// ── item 5: per-business model override ─────────────────────────────────────

test('persona.conversation_model overrides the model for every call this turn makes', async () => {
  const models = [];
  let n = 0;
  _setMessagesCreateForTest(async (params) => {
    models.push(params.model);
    n += 1;
    if (n === 1) return { content: [{ text: INTENT_OK }], usage: usage() };
    return { content: [{ text: REPLY_OK }], usage: usage() };
  });

  await runConversation({
    message: 'מה שעות הפעילות?', session_id: 's1',
    context: baseContext({ persona: { conversation_model: 'claude-haiku-4-5-20251001' } }),
  });

  assert.deepEqual(models, ['claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001']);
});

test('an unrecognized conversation_model override falls back to the default model', async () => {
  const models = [];
  let n = 0;
  _setMessagesCreateForTest(async (params) => {
    models.push(params.model);
    n += 1;
    if (n === 1) return { content: [{ text: INTENT_OK }], usage: usage() };
    return { content: [{ text: REPLY_OK }], usage: usage() };
  });

  await runConversation({
    message: 'מה שעות הפעילות?', session_id: 's1',
    context: baseContext({ persona: { conversation_model: 'claude-3-opus-not-a-real-alias' } }),
  });

  assert.deepEqual(models, ['claude-sonnet-4-6', 'claude-sonnet-4-6']);
});

test('no override at all uses the default model', async () => {
  const models = [];
  let n = 0;
  _setMessagesCreateForTest(async (params) => {
    models.push(params.model);
    n += 1;
    if (n === 1) return { content: [{ text: INTENT_OK }], usage: usage() };
    return { content: [{ text: REPLY_OK }], usage: usage() };
  });

  await runConversation({ message: 'מה שעות הפעילות?', session_id: 's1', context: baseContext() });

  assert.deepEqual(models, ['claude-sonnet-4-6', 'claude-sonnet-4-6']);
});
