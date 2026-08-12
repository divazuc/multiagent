// The owner's rule, dictated in the live demo:
//   "הפניה הראשונית היא בזכר אלא אם זיהינו לפי הכתיבה שמדובר בנקבה"
//
// Hebrew has no neutral second person, so the bot has to pick one and the
// masculine is what reads as neutral. This is prompt text, so the test reads
// the system prompt the model is actually handed — the same seam
// conversation-modules.test.js uses — rather than grepping the source and
// hoping the string reached a prompt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runConversation, _setMessagesCreateForTest } from '../agents/conversation.js';

const INTENT = JSON.stringify({
  detected_intent: 'info_seeking', sentiment: 'neutral', language: 'hebrew',
  urgency: 'low', cta_decision: 'clarify', qualification_complete: false,
  missing_fields: [], escalate: false, escalation_reason: null, qualification_progress: {},
});

const STOP = 'stop-after-capture';

// Cost-efficiency pass (2026-08-12): the reply prompt's `system` is now an
// array of blocks — a cached STABLE prefix + a small DYNAMIC tail (see
// agents/conversation.js#callClaude) — instead of one string. Every rule this
// file checks (ADDRESS_GENDER_RULE) lives in the stable block; joining the
// blocks' text preserves the exact relative ordering a plain string would
// have had, so every assertion below is unchanged in spirit.
function systemText(system) {
  return Array.isArray(system) ? system.map(b => b.text).join('\n') : system;
}

// Call 1 is intent detection; call 2 is the reply prompt — the subject of this
// test. Throwing on call 2 ends the run right there, so the suite never sits
// through the human-typing delay that a completed reply would trigger.
async function captureReplyPrompt(agent_mode) {
  let system = null;
  let n = 0;
  _setMessagesCreateForTest(async (params) => {
    if (++n === 1) return { content: [{ text: INTENT }] };
    system = systemText(params.system);
    throw new Error(STOP);
  });
  try {
    const out = await runConversation({
      message: 'היי, אשמח לפרטים על דף נחיתה',
      session_id: '972500000009',
      context: {
        business_id: 'b1',
        business_profile: { business_name: 'Diva Ost', agent_mode },
        persona: {}, guardrails: {}, hebrew_patterns: {},
        conversation_history: [], missing_qualification_data: [],
        current_stage: 'greeting',
      },
    });
    assert.equal(out.error, STOP, 'the capture seam must have been reached');
  } finally {
    _setMessagesCreateForTest(null);
  }
  assert.ok(system, `no reply prompt was built for agent_mode=${agent_mode}`);
  return system;
}

const MODES = ['sales', 'support', 'hybrid'];

test('every mode opens in the masculine — the standard neutral address in Hebrew', async () => {
  for (const mode of MODES) {
    const system = await captureReplyPrompt(mode);
    assert.match(system, /MASCULINE second-person forms by default/,
      `${mode}: the default address must be stated, not left to the model`);
    assert.match(system, /אתה/, `${mode}: the masculine forms must be named`);
  }
});

test('the switch to feminine is driven by the customer\'s own writing, nothing else', async () => {
  for (const mode of MODES) {
    const system = await captureReplyPrompt(mode);
    assert.match(system, /FEMININE second-person forms/, `${mode}`);
    assert.match(system, /OWN writing/,
      `${mode}: a name or a profile photo is not evidence — her writing is`);
    assert.match(system, /מעוניינת/, `${mode}: name a real feminine marker to look for`);
    assert.match(system, /while it is unclear stay masculine/,
      `${mode}: ambiguity resolves to the default, it does not license a guess`);
  }
});

test('once identified as a woman the feminine holds for the rest of the conversation', async () => {
  for (const mode of MODES) {
    const system = await captureReplyPrompt(mode);
    assert.match(system, /ENTIRE rest of the conversation/, `${mode}`);
    assert.match(system, /never switch back to masculine/,
      `${mode}: flipping back mid-conversation is the failure this rule exists to prevent`);
  }
});

// A guard for the next mode someone adds: the rule has to be wired into the
// prompt builder, and the source is the only place that fact is visible.
test('all three mode prompts interpolate the rule', () => {
  const src = fs.readFileSync(new URL('../agents/conversation.js', import.meta.url), 'utf8');
  assert.equal((src.match(/\$\{ADDRESS_GENDER_RULE\}/g) ?? []).length, 3,
    'sales, support and hybrid — a mode without the rule addresses women in the masculine');
});

// The rewrite loop re-generates the text from scratch. Without this it can
// hand back a masculine rewrite of a reply that was correctly feminine.
test('the rewrite loop is told to preserve the gender of address', async () => {
  const captured = [];
  let n = 0;
  _setMessagesCreateForTest(async (params) => {
    captured.push(params);
    if (++n === 1) return { content: [{ text: INTENT }] };
    // A reply with two questions — validate() flags it and calls rewrite().
    if (n === 2) return { content: [{ text: 'מה השם שלך? ומה התקציב שלך?' }] };
    throw new Error(STOP);
  });
  try {
    await runConversation({
      message: 'היי',
      session_id: '972500000009',
      context: {
        business_id: 'b1',
        business_profile: { business_name: 'Diva Ost', agent_mode: 'sales' },
        persona: {}, guardrails: {}, hebrew_patterns: {},
        conversation_history: [], missing_qualification_data: [],
        current_stage: 'greeting',
      },
    });
  } finally {
    _setMessagesCreateForTest(null);
  }
  const rewritePrompt = captured[2]?.messages?.[0]?.content ?? '';
  assert.match(rewritePrompt, /gender of address/,
    'the rewrite must not undo a correctly-detected feminine address');
});
