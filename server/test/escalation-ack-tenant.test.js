import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEscalatedAckPrompt, CONVERSATION_CLIENT_OPTIONS,
} from '../agents/conversation.js';

// Owner, 2026-08-29 (Diva Ost E2E): her business bot answered an escalation with
// "העברתי למאמן" — the kids tenant's handoff target had been baked into the
// SHARED escalated-acknowledgement prompt ("handed off to the coach"). Tenants
// must be fully separate: the prompt takes WHO the customer is handed to from
// the tenant's own data (persona.escalation_phrase, then the profile's
// contact_name), never from a word written for another business.

const DIVA = {
  persona: {
    bot_name: 'דיוה', bot_gender: 'female',
    escalation_phrase: 'אני מעבירה אותך לדיוה — היא תחזור אליך בהקדם 🙏',
  },
  business_profile: { business_name: 'דיוה אוסט', contact_name: 'דיוה' },
};
const KIDS = {
  persona: { bot_name: 'נועה', bot_gender: 'female', escalation_phrase: 'אני אבדוק עם המאמנת ונחזור אליכם 🙂' },
  business_profile: { business_name: 'קרוספיט קידס — הדרקונים', contact_name: null },
};
const base = { message: 'לא, אני רוצה להתחיל את כל התהליך מחדש', conversation_history: [], language: 'hebrew' };

test('the Diva Ost tenant hands off to דיוה — in the business\'s own words, and no "coach" anywhere', () => {
  const prompt = buildEscalatedAckPrompt({ ...base, ...DIVA });
  assert.ok(prompt.includes(DIVA.persona.escalation_phrase), 'quotes the tenant\'s own handoff line verbatim');
  assert.doesNotMatch(prompt, /coach|trainer|מאמן|מאמנת/i, 'nothing from another tenant\'s vocabulary');
});

test('the kids tenant still hands off to המאמנת — via ITS line, not a hard-coded word', () => {
  const prompt = buildEscalatedAckPrompt({ ...base, ...KIDS });
  assert.ok(prompt.includes('המאמנת'));
  assert.doesNotMatch(prompt, /\bcoach\b/i, 'the English word is not in the shared prompt either');
});

test('without an escalation phrase the contact name is the handoff target; without both, a neutral person', () => {
  const named = buildEscalatedAckPrompt({ ...base, persona: { bot_gender: 'female' }, business_profile: { contact_name: 'רוני' } });
  assert.ok(named.includes('רוני'));
  const neutral = buildEscalatedAckPrompt({ ...base, persona: {}, business_profile: {} });
  assert.doesNotMatch(neutral, /coach|מאמן|נציג/i);
  assert.match(neutral, /person/i, 'falls back to a neutral human, not a role from any tenant');
});

test('the prompt tells the model to acknowledge the latest message, and forbids questions, links and reuse', () => {
  const prompt = buildEscalatedAckPrompt({ ...base, ...DIVA, conversation_history: [
    { role: 'user', content: 'שלום אני מתעניינת לבנות אתר' }, { role: 'assistant', content: 'שלום! …' },
  ] });
  assert.match(prompt, /LATEST message/);
  assert.match(prompt, /No questions, no links, no sales/);
  assert.ok(prompt.includes(base.message));
  assert.ok(prompt.includes('שלום אני מתעניינת לבנות אתר'), 'carries the recent history');
});

// Owner, 2026-08-29: one reply took 2m22s inside the model calls. The SDK's
// defaults (10-minute timeout, 2 retries with backoff) turn an API stall into
// minutes of silence on WhatsApp. The live conversation client is bounded.
test('the conversation client is bounded: a short timeout and at most one retry', () => {
  assert.ok(CONVERSATION_CLIENT_OPTIONS.timeout <= 30_000, 'timeout ≤ 30s');
  assert.ok(CONVERSATION_CLIENT_OPTIONS.timeout >= 10_000, 'but not so short that a normal Sonnet call fails');
  assert.ok(CONVERSATION_CLIENT_OPTIONS.maxRetries <= 1);
});
