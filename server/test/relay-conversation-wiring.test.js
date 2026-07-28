// server/test/relay-conversation-wiring.test.js
//
// The ONE production entry point into the relay. Every other relay test calls
// raiseEscalation directly, and the E2E runbook does too — so a guard on a key
// that does not exist (`business_profile.business_id`) made the whole feature a
// silent no-op and 177 green tests said nothing about it.
//
// These tests drive runConversation with a context shaped exactly like
// loadContext's success result, and assert the rep is really messaged.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as contacts from '../lib/relay/contacts.js';
import * as store from '../lib/relay/store.js';
import * as relay from '../lib/relay/index.js';
import { runConversation, _setMessagesCreateForTest } from '../agents/conversation.js';

// Mirrors lib/context.js:100-125 exactly: `business_id` lives at the TOP level
// and `business_profile` is an explicit object literal that does NOT contain
// it. If this fixture ever drifts from loadContext, the wiring it protects is
// no longer protected — keep the key list in sync.
function loadContextShaped(overrides = {}) {
  return {
    business_id: 'b1',
    session_mode: 'live',
    setup_completed: true,
    current_stage: 'greeting',
    draft_setup_data: {},
    business_profile: {
      business_name: 'קליניקה',
      business_model: null,
      sales_goal: null,
      conversation_strategy: null,
      services: [],
      decision_logic: null,
      key_questions: null,
      objection_handling: null,
      agent_mode: 'hybrid',
      cta_goal: 'book_call',
      knowledge: {},
    },
    persona: { bot_gender: 'female' },
    guardrails: {},
    hebrew_patterns: {},
    conversation_history: [],
    missing_qualification_data: [],
    qualification_progress: {},
    ...overrides,
  };
}

function seedRelay({ rep = { business_id: 'b1', role: 'rep', name: 'סאלי', phone: '972500000001' } } = {}) {
  contacts._setDbForTest({
    async listContacts() { return rep ? [rep] : []; },
    async upsertContact() {},
  });
  const rows = [];
  store._setDbForTest({
    async insert(row) { const r = { id: `e${rows.length + 1}`, ...row }; rows.push(r); return r; },
    async listOpen() { return [...rows].reverse(); },
    async listAllOpen() { return rows; },
    async update(id, patch) { Object.assign(rows.find(r => r.id === id), patch); },
  });
  relay._setDbForTest({
    async getBusiness() { return { whatsapp_number: '972599999999' }; },
    async getSession() { return { qualification_progress: {} }; },
    async listPlatformWhatsappNumbers() { return [{ whatsapp_number: '972599999999' }]; },
    async getLeadContact() { return null; },
  });
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.REP' }] }; });
  return { rows, sent };
}

function escalatingIntent() {
  return async () => ({
    content: [{
      text: JSON.stringify({
        detected_intent: 'human_request', sentiment: 'neutral', language: 'hebrew',
        urgency: 'high', cta_decision: 'escalate', qualification_complete: false,
        missing_fields: [], escalate: true, escalation_reason: 'pricing',
        qualification_progress: { need: 'טיפול פנים' },
      }),
    }],
  });
}

test('runConversation actually raises an escalation for a real loadContext-shaped context', async () => {
  const { rows, sent } = seedRelay();
  _setMessagesCreateForTest(escalatingIntent());

  const out = await runConversation({
    message: 'אפשר לפרוס לתשלומים?',
    session_id: '972500000009',
    context: loadContextShaped(),
  });

  _setMessagesCreateForTest(null);

  assert.equal(out.status, 'success');
  assert.equal(out.result.escalate, true);
  assert.equal(sent.length, 1, 'the rep must actually be messaged — this is the whole feature');
  assert.equal(sent[0].to, '972500000001');
  assert.equal(rows.length, 1, 'an escalation row must exist');
  assert.equal(rows[0].business_id, 'b1', 'the business id must come from context.business_id, not business_profile');
  assert.equal(rows[0].session_id, '972500000009');
  assert.equal(out.result.response, 'אני צריכה לבדוק את זה, אעדכן בקרוב.',
    'the lead gets the relay holding line, not the dead-end "מעבירה אותך לנציגה" sentence');
});

test('with no reachable rep the lead still gets the old dead-end phrase and no row is created', async () => {
  const { rows, sent } = seedRelay({ rep: null });
  _setMessagesCreateForTest(escalatingIntent());

  const out = await runConversation({
    message: 'אפשר לפרוס לתשלומים?',
    session_id: '972500000009',
    context: loadContextShaped(),
  });

  _setMessagesCreateForTest(null);

  assert.equal(sent.length, 0);
  assert.equal(rows.length, 0);
  assert.equal(out.result.escalate, true);
  assert.match(out.result.response, /מעבירה אותך/, 'falls back to today\'s behaviour, never a holding line nobody can honour');
});
