// Live pilot, 2026-08-12: the model sometimes wraps the WHOLE reply in
// quotation marks — a perfect answer delivered to the customer as "…text…".
// stripWrappingQuotes (lib/outbound-text.js) is the deterministic backstop,
// applied wherever model text settles (agents/conversation.js, lib/relay);
// NO_QUOTE_WRAP_RULE is the prompt-side half of the same fix.

import test from 'node:test';
import assert from 'node:assert/strict';
import { stripWrappingQuotes } from '../lib/outbound-text.js';
import { runConversation, _setMessagesCreateForTest } from '../agents/conversation.js';

// ── The sanitizer itself ─────────────────────────────────────────────────────

test('the live case: a whole reply wrapped in straight double quotes is unwrapped', () => {
  assert.equal(
    stripWrappingQuotes('"היי! כן, יש מקום בקבוצת כיתות א׳–ג׳ ביום רביעי 16:45 🙂"'),
    'היי! כן, יש מקום בקבוצת כיתות א׳–ג׳ ביום רביעי 16:45 🙂');
});

test('every supported wrapping pair is stripped', () => {
  assert.equal(stripWrappingQuotes("'שלום לך'"), 'שלום לך');
  assert.equal(stripWrappingQuotes('“שלום לך”'), 'שלום לך');
  assert.equal(stripWrappingQuotes('”שלום לך“'), 'שלום לך');
  assert.equal(stripWrappingQuotes('„שלום לך“'), 'שלום לך');
  assert.equal(stripWrappingQuotes('„שלום לך”'), 'שלום לך');
  assert.equal(stripWrappingQuotes('«שלום לך»'), 'שלום לך');
  assert.equal(stripWrappingQuotes('״שלום לך״'), 'שלום לך');
});

test('a reply that merely CONTAINS quotes is untouched', () => {
  const s = 'התוכנית "דרקונים" מתאימה מגיל 6, והמאמנת אמרה "יש מקום"';
  assert.equal(stripWrappingQuotes(s), s);
});

test('inner quotes survive when an outer pair is stripped', () => {
  assert.equal(
    stripWrappingQuotes('"זה המסלול ה\'אקספרס\' שלנו"'),
    "זה המסלול ה'אקספרס' שלנו");
});

test('a lone leading or trailing quote is untouched', () => {
  assert.equal(stripWrappingQuotes('"שלום לך'), '"שלום לך');
  assert.equal(stripWrappingQuotes('שלום לך"'), 'שלום לך"');
});

test('a mismatched pair is untouched', () => {
  assert.equal(stripWrappingQuotes('"שלום לך\''), '"שלום לך\'');
  assert.equal(stripWrappingQuotes('«שלום לך"'), '«שלום לך"');
});

test('exactly ONE outer pair is stripped, never more', () => {
  assert.equal(stripWrappingQuotes('""שלום""'), '"שלום"');
});

test('degenerate inputs come back trimmed and unharmed', () => {
  assert.equal(stripWrappingQuotes(''), '');
  assert.equal(stripWrappingQuotes(null), '');
  assert.equal(stripWrappingQuotes('"'), '"');
  assert.equal(stripWrappingQuotes('""'), '');
  assert.equal(stripWrappingQuotes('  שלום  '), 'שלום');
});

// ── Wired into the conversation agent ────────────────────────────────────────

const INTENT = JSON.stringify({
  detected_intent: 'info_seeking', sentiment: 'neutral', language: 'hebrew',
  urgency: 'low', cta_decision: 'clarify', qualification_complete: false,
  missing_fields: [], escalate: false, escalation_reason: null, qualification_progress: {},
});

test('a quote-wrapped model reply reaches the customer bare (full runConversation path)', async () => {
  let n = 0;
  _setMessagesCreateForTest(async () => {
    n += 1;
    if (n === 1) return { content: [{ text: INTENT }] };
    return { content: [{ text: '"היי! יש מקום בקבוצת כיתות א׳–ג׳ ביום רביעי, אשמח לעזור 🙂"' }] };
  });
  try {
    const out = await runConversation({
      message: 'יש מקום בקבוצה של רביעי?',
      session_id: '972500000009',
      context: {
        business_id: 'b1',
        business_profile: { business_name: 'קרוספיט קידס', agent_mode: 'support' },
        persona: {}, guardrails: {}, hebrew_patterns: {},
        conversation_history: [], missing_qualification_data: [],
        current_stage: 'greeting',
      },
    });
    assert.equal(out.status, 'success');
    assert.equal(out.result.response, 'היי! יש מקום בקבוצת כיתות א׳–ג׳ ביום רביעי, אשמח לעזור 🙂');
  } finally {
    _setMessagesCreateForTest(null);
  }
});

test('all three modes carry the no-quote-wrap prompt rule next to the authenticity rule', async () => {
  for (const agent_mode of ['sales', 'support', 'hybrid']) {
    let system = null;
    let n = 0;
    _setMessagesCreateForTest(async (params) => {
      if (++n === 1) return { content: [{ text: INTENT }] };
      // Cost-efficiency pass: system is now [stable, dynamic] blocks. Both
      // rules this test checks live in the stable block, so joining the
      // blocks' text preserves the relative order a plain string would have.
      system = Array.isArray(params.system) ? params.system.map(b => b.text).join('\n') : params.system;
      throw new Error('stop-after-capture');
    });
    try {
      await runConversation({
        message: 'היי',
        session_id: '972500000009',
        context: {
          business_id: 'b1',
          business_profile: { business_name: 'X', agent_mode },
          persona: {}, guardrails: {}, hebrew_patterns: {},
          conversation_history: [], missing_qualification_data: [],
          current_stage: 'greeting',
        },
      });
    } finally {
      _setMessagesCreateForTest(null);
    }
    assert.ok(system, `${agent_mode}: no reply prompt captured`);
    assert.match(system, /Never wrap your entire reply in quotation marks/, agent_mode);
    assert.ok(system.indexOf('Authenticity (platform rule') < system.indexOf('Never wrap your entire reply'),
      `${agent_mode}: the rule sits next to the authenticity rule`);
  }
});
