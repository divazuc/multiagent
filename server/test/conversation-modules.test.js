import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runConversation, _setMessagesCreateForTest } from '../agents/conversation.js';

test('conversation.js extracts the action before validateAndFix', () => {
  const src = fs.readFileSync(new URL('../agents/conversation.js', import.meta.url), 'utf8');
  const extractIdx = src.indexOf('extractModuleAction(candidate)');
  const validateIdx = src.indexOf('validateAndFix({ candidate');
  assert.ok(extractIdx > -1 && validateIdx > -1 && extractIdx < validateIdx);
});

test('all three mode prompts include modules_context', () => {
  const src = fs.readFileSync(new URL('../agents/conversation.js', import.meta.url), 'utf8');
  assert.equal((src.match(/modules_context \? /g) || []).length, 3);
});

test('pipeline sends outbound_response (module confirmation included) to WhatsApp', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(src.includes('text: outbound_response'));
  assert.ok(src.includes("'meeting_booked'"));
});

// T9 (funnel track 1): the old hint blanket-forced escalate=false for ANY
// scheduling request ("A customer asking to schedule … is a NORMAL bot flow"),
// which contradicted the express one-meeting guardrail — an extra-meeting
// request must reach the module layer (request_callback / the booking gate),
// and the module context blocks are what define that scope, not the hint.
test('the intent hint defers scope decisions to the module context blocks instead of a blanket escalate=false', async () => {
  const captured = [];
  _setMessagesCreateForTest(async (params) => {
    captured.push(params);
    return {
      content: [{
        text: JSON.stringify({
          detected_intent: 'info_seeking', sentiment: 'neutral', language: 'hebrew',
          urgency: 'low', cta_decision: 'escalate', qualification_complete: false,
          missing_fields: [], escalate: true, escalation_reason: 'x', qualification_progress: {},
        }),
      }],
    };
  });
  try {
    await runConversation({
      message: 'אפשר לקבוע עוד פגישה?',
      session_id: '972500000009',
      context: {
        business_id: null, // escalate exits fast with the fallback phrase — this test only reads the prompt
        business_profile: { business_name: 'Diva Ost', agent_mode: 'hybrid' },
        persona: {}, guardrails: {}, hebrew_patterns: {},
        conversation_history: [], missing_qualification_data: [],
        current_stage: 'greeting',
        modules_context: '## תיאום פגישות\n...',
      },
    });
  } finally {
    _setMessagesCreateForTest(null);
  }
  const system = captured[0].system;
  assert.match(system, /module context blocks/,
    'the hint must point the intent engine at the module context as the scope authority');
  assert.match(system, /escalate=false/,
    'completing an in-scope module flow must still not be routed to a human');
  assert.doesNotMatch(system, /A customer asking to schedule/,
    'the blanket "any scheduling request is a bot flow" sentence is exactly what T9 removes');
});

test('without modules the intent prompt carries no module hint at all', async () => {
  const captured = [];
  _setMessagesCreateForTest(async (params) => {
    captured.push(params);
    return {
      content: [{
        text: JSON.stringify({
          detected_intent: 'info_seeking', sentiment: 'neutral', language: 'hebrew',
          urgency: 'low', cta_decision: 'escalate', qualification_complete: false,
          missing_fields: [], escalate: true, escalation_reason: 'x', qualification_progress: {},
        }),
      }],
    };
  });
  try {
    await runConversation({
      message: 'שלום',
      session_id: '972500000009',
      context: {
        business_id: null,
        business_profile: { business_name: 'עסק', agent_mode: 'hybrid' },
        persona: {}, guardrails: {}, hebrew_patterns: {},
        conversation_history: [], missing_qualification_data: [],
        current_stage: 'greeting',
      },
    });
  } finally {
    _setMessagesCreateForTest(null);
  }
  assert.doesNotMatch(captured[0].system, /module context blocks/);
});

// Owner, 2026-08-29 (E2E): "אפשר להזיז את הפגישה?" was escalated by the intent step
// ("בקשה לשינוי פגישה קיימת — דורש טיפול ידני") before the reply model ever saw the
// module context that handles it. Moving an existing meeting is the same in-chat
// flow as booking one — through the owner's approval — never a human handoff.
test('the intent hint names moving/changing an existing meeting as a normal in-chat flow (escalate=false)', async () => {
  const captured = [];
  _setMessagesCreateForTest(async (params) => {
    captured.push(params);
    return { content: [{ text: JSON.stringify({
      detected_intent: 'info_seeking', sentiment: 'neutral', language: 'hebrew', urgency: 'low',
      cta_decision: 'escalate', qualification_complete: false, missing_fields: [], escalate: true,
      escalation_reason: 'x', qualification_progress: {},
    }) }] };
  });
  try {
    await runConversation({
      message: 'אפשר להזיז את הפגישה?', session_id: '972500000010',
      context: {
        business_id: null, business_profile: { business_name: 'Diva Ost', agent_mode: 'hybrid' },
        persona: {}, guardrails: {}, hebrew_patterns: {}, conversation_history: [], missing_qualification_data: [],
        current_stage: 'qualification', modules_context: '## תיאום פגישות\n...',
      },
    });
  } finally { _setMessagesCreateForTest(null); }
  const system = captured[0].system;
  assert.match(system, /existing meeting/i, 'the hint must speak about meetings that already exist');
  assert.match(system, /(moving|changing|reschedul)[^.]*existing meeting[^.]*escalate=false/i,
    'moving/changing an existing meeting is an in-chat flow, not a handoff');
});
