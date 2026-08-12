// WA_03 + WA_05 replacement — intent detection, response generation, validation
// Supports three agent modes: sales / support / hybrid

import Anthropic from '@anthropic-ai/sdk';
import { replyDelayMs } from '../lib/reply-delay.js';
import { extractModuleAction } from '../lib/modules/actions.js';
import { stripWrappingQuotes } from '../lib/outbound-text.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL  = 'claude-sonnet-4-6';

// Test seam for the model call — same convention as lib/relay/index.js. Every
// branch of runConversation is gated behind detectIntent, so without this the
// escalation wiring below could only ever be asserted by grepping the source.
// It is exactly that gap that let a guard on a non-existent key ship as a
// production no-op.
let messagesCreate = null;
export function _setMessagesCreateForTest(fn) { messagesCreate = fn; }
async function createMessage(params) {
  return messagesCreate ? messagesCreate(params) : client.messages.create(params);
}

const MAX_VALIDATION_RETRIES = 2;
const GENERIC_AI_PHRASES = ['certainly', 'of course', 'absolutely', 'as an ai', 'i am an ai', 'i cannot'];

export async function runConversation({ message, session_id, context }) {
  // The reply-delay window is measured end-to-end from here, so a slow model
  // call eats the budget instead of being padded on top of it.
  const startedAt = Date.now();
  try {
    const {
      business_id, business_profile, persona, guardrails, hebrew_patterns,
      conversation_history, missing_qualification_data, current_stage,
    } = context;

    const agent_mode = business_profile?.agent_mode ?? context.agent_mode ?? 'sales';
    const cta_goal   = business_profile?.cta_goal   ?? context.cta_goal   ?? 'book_call';

    // ── Step 1: Detect intent ─────────────────────────────────────────────────
    const intent = await detectIntent({
      message, business_profile, missing_qualification_data,
      conversation_history, current_stage, agent_mode, guardrails,
      has_modules: !!context.modules_context,
    });

    // Hard escalation — all modes
    if (intent.escalate) {
      const { raiseEscalation } = await import('../lib/relay/index.js');
      // `business_id` is a TOP-LEVEL key of loadContext's result
      // (lib/context.js:101) — `business_profile` is an explicit literal built
      // from the business_profiles columns and has never contained it. Guarding
      // on `business_profile.business_id` made this branch dead in production
      // while every unit test still passed, because they all call
      // raiseEscalation directly. server/index.js reads context.business_id for
      // buildModulesContext/executeModuleAction; this now matches.
      const relayed = business_id
        ? await raiseEscalation({
            business: { id: business_id, name: business_profile?.business_name ?? '' },
            session_id, question: message,
            reason: intent.escalation_reason ?? null,
            // The rep's message needs to say WHO is asking. The name and the
            // ai_summary snapshot are resolved inside the relay (it owns the
            // db seam); the history is the fallback for a lead whose summary
            // hasn't been generated yet, and only this layer has it loaded.
            history: conversation_history,
            persona,
          })
        : null;
      const phrase = relayed?.holdingLine
        ?? persona?.escalation_phrase
        ?? (persona?.bot_gender === 'male' ? 'אני מעביר אותך לנציג שלנו כעת.' : 'אני מעבירה אותך לנציגה שלנו כעת.');
      return ok({
        response: phrase, next_stage: 'escalated', action: 'none',
        cta_triggered: false, escalate: true,
        escalation_reason: intent.escalation_reason,
        qualification_progress: intent.qualification_progress ?? context.qualification_progress ?? {},
        language: intent.language ?? 'hebrew',
      });
    }

    // ── Step 2: Generate response based on mode ───────────────────────────────
    let candidate;

    const modules_context = context.modules_context ?? null;

    if (agent_mode === 'support') {
      candidate = await generateSupportResponse({ message, business_profile, persona, hebrew_patterns, conversation_history, intent, guardrails, modules_context });
    } else if (agent_mode === 'hybrid') {
      candidate = await generateHybridResponse({ message, business_profile, persona, hebrew_patterns, conversation_history, intent, cta_goal, guardrails, modules_context });
    } else {
      candidate = await generateSalesResponse({ message, business_profile, persona, hebrew_patterns, conversation_history, intent, cta_goal, guardrails, modules_context });
    }

    // Modules: the model may append an ACTION marker — extract it BEFORE
    // validation so the rewrite loop never sees or mangles the marker.
    const extracted = extractModuleAction(candidate);
    candidate = extracted.text;

    // ── Step 3: Validate + rewrite loop ───────────────────────────────────────
    const validated = await validateAndFix({ candidate, persona, guardrails, intent, agent_mode });

    if (!validated.passed) {
      return ok({
        response: '', next_stage: 'escalated', action: 'none',
        cta_triggered: false, escalate: true,
        escalation_reason: 'Response failed validation after max retries',
        qualification_progress: intent.qualification_progress ?? {},
        language: intent.language ?? 'hebrew',
      });
    }

    const { next_stage, action, cta_triggered } = mapCtaDecision(intent.cta_decision, agent_mode);

    // Human-like delay before responding
    const answerLength = business_profile?.answer_length ?? persona?.answer_length ?? 'short';
    await humanDelay(validated.text, answerLength, startedAt);

    return ok({
      response: validated.text,
      next_stage, action, cta_triggered,
      escalate: false, escalation_reason: null,
      qualification_progress: intent.qualification_progress ?? {},
      language: intent.language ?? 'hebrew',
      rewrite_applied: validated.rewrite_applied,
      module_action: extracted.action,
    });

  } catch (e) {
    return { status: 'error', result: null, error: e.message };
  }
}

// ── Intent detection ──────────────────────────────────────────────────────────

// Bot identity (admin-managed): the name the bot introduces itself with and
// its grammatical gender — critical for Hebrew first-person forms.
function identityText(persona) {
  const parts = [];
  if (persona?.bot_name) {
    parts.push(`Your name is "${persona.bot_name}" — introduce yourself by this name when greeting or when asked who you are.`);
  }
  if (persona?.bot_gender === 'male') {
    parts.push('Speak Hebrew in consistent MASCULINE first-person forms (שמח, מעביר, אשמח לעזור לך).');
  } else if (persona?.bot_gender === 'female') {
    parts.push('Speak Hebrew in consistent FEMININE first-person forms (שמחה, מעבירה, אשמח לעזור לך).');
  }
  return parts.length ? '\n' + parts.join(' ') : '';
}

// Per-business policy (admin-managed): named escalation triggers and
// forbidden topics, stored in business_profiles.guardrails.
function policyText(guardrails) {
  const esc = [...(guardrails?.escalation_points ?? [])];
  if (guardrails?.escalation_custom?.trim()) esc.push(guardrails.escalation_custom.trim());
  const forb = [...(guardrails?.forbidden_topics ?? [])];
  if (guardrails?.forbidden_custom?.trim()) forb.push(guardrails.forbidden_custom.trim());
  let out = '';
  if (esc.length) out += `\nEscalation policy — if the customer's message falls under any of these, escalate to a human (escalate=true): ${esc.join(' · ')}.`;
  if (forb.length) out += `\nStrictly forbidden — the bot must NEVER answer, promise or commit on: ${forb.join(' · ')}. If asked about these, politely say a human representative will handle it.`;
  return out;
}

async function detectIntent({ message, business_profile, missing_qualification_data, conversation_history, current_stage, agent_mode, guardrails, has_modules }) {
  const modeInstruction = {
    sales:   'Bias toward CTA opportunities. Identify qualification gaps and push toward conversion.',
    support: 'Bias toward resolution. Focus on what the customer needs answered or resolved.',
    hybrid:  'Balance resolution with opportunity. Note if customer seems interested after their question.',
  }[agent_mode] ?? '';

  // When automated capabilities (e.g. calendar booking) are active, a customer
  // completing that flow — picking a slot, leaving name/phone for a booking —
  // must NOT be routed to a human; the bot finishes the job itself.
  //
  // T9 (funnel track 1): deliberately NOT a blanket "any scheduling request is
  // a bot flow" — that wording contradicted the express one-meeting guardrail
  // (an express client asking for an EXTRA meeting must reach the module
  // layer's own handoff, booster.request_callback, not be force-completed).
  // Scope is defined by the module context blocks in the reply prompt; the
  // intent engine's only job here is not to hijack module flows into a human
  // escalation.
  const modulesHint = has_modules
    ? '\nThe bot has ACTIVE automated capabilities it completes by itself (e.g. booking meetings from real calendar availability). A customer moving through one of those flows — choosing an offered slot, or giving their name/phone to complete a booking — is a NORMAL bot flow: escalate=false for it. The module context blocks in the reply prompt define WHICH requests are in scope and which get the modules\' own handoff actions (e.g. an express client asking for an extra meeting) — do not blanket-approve every scheduling request and do not escalate it either; leave it to those blocks. Escalate only on the escalation policy above or an explicit demand for a human.'
    : '';

  const system = `You are an intent detection engine for a WhatsApp business agent.
${modeInstruction}${policyText(guardrails)}${modulesHint}
Return ONLY valid JSON:
{
  "detected_intent": "high_intent|info_seeking|complaint|objection|unclear|human_request|ready_to_buy",
  "sentiment": "positive|neutral|frustrated|angry",
  "language": "hebrew|english|mixed",
  "urgency": "low|medium|high",
  "cta_decision": "cta|qualify|clarify|resolve|escalate",
  "qualification_complete": boolean,
  "missing_fields": [],
  "escalate": boolean,
  "escalation_reason": null,
  "qualification_progress": {"need":null,"scope":null,"budget":null,"timeline":null,"urgency":null}
}`;

  const userPrompt = `Business: ${JSON.stringify(business_profile)}
Missing qualification: ${JSON.stringify(missing_qualification_data)}
History: ${JSON.stringify(conversation_history.slice(-6))}
Stage: ${current_stage}
Message: "${message}"`;

  const response = await createMessage({
    model: MODEL, max_tokens: 1024,
    system, messages: [{ role: 'user', content: userPrompt }],
  });

  try {
    const text = response.content[0].text.replace(/```json\n?|\n?```/g, '').trim();
    return JSON.parse(text);
  } catch {
    return {
      detected_intent: 'unclear', sentiment: 'neutral', language: 'hebrew',
      urgency: 'low', cta_decision: 'clarify', escalate: false,
      qualification_progress: {},
    };
  }
}

// Anti-hallucination: the model may only answer from what it was given.
const GROUNDING_RULE = `Grounding rule: answer ONLY from the Business info, the knowledge provided and this conversation. NEVER invent facts, services, prices, discounts, addresses or availability. If you don't have the information, say honestly that you'll check with the team, and ask for the customer's name and phone so a representative can follow up.`;

// Shared rule: when the reply promises an action that needs a contact detail
// we don't have yet (e-mail for a quote, phone for a callback), ask for it
// inline, naturally, in the same reply — and never re-ask for details the
// customer already gave earlier in the conversation.
const MISSING_DETAILS_RULE = `Missing-details rule: if you offer or promise an action that requires a contact detail (e-mail to send a quote/summary, phone number for a callback, full name for a booking), check the conversation history: if the customer already provided it — use it, never ask again. If it's missing — weave a short natural request for it into the SAME reply, e.g. "אעבוד על הצעת המחיר ואשלח לך במייל בהקדם — לאיזה מייל לשלוח?"`;

// Owner rule, dictated in the live demo:
//   "הפניה הראשונית היא בזכר אלא אם זיהינו לפי הכתיבה שמדובר בנקבה"
//
// Hebrew has no neutral second person, so something has to be the default and
// the masculine is what reads as neutral. Two things this rule is careful about:
// the evidence for switching is the customer's OWN writing — never a guess from
// a name, a display picture or a "sounds like a woman's question" — and the
// switch is one-way. Flipping back to masculine three messages after correctly
// identifying a woman reads worse than never having switched at all.
//
// Distinct from identityText() below: that one is the bot's own first-person
// gender (admin-managed). This is how the bot addresses the person it's talking
// to, which nobody configures because only the conversation can reveal it.
const ADDRESS_GENDER_RULE = `Gender of address (Hebrew): address the customer in MASCULINE second-person forms by default (אתה, תוכל, מעוניין, רוצה) — in Hebrew that is the standard neutral address, so this is where every conversation starts. Switch to FEMININE second-person forms (את, תוכלי, מעוניינת, רוצה) ONLY when the customer's OWN writing shows she is a woman: she writes about herself in feminine forms (מעוניינת, צריכה, מחפשת, יכולה, בטוחה), states it explicitly, or gives a clearly feminine name as her own. Do not infer it from anything else, and while it is unclear stay masculine. Once you have identified the customer as a woman, address her in the feminine for the ENTIRE rest of the conversation, in every following message — never switch back to masculine.`;
const AUTHENTICITY_RULE = `Authenticity (platform rule, every business): NEVER present yourself as a bot, chat, AI, virtual assistant or automated system, and never volunteer that you are one — no "אני הצ'אט של…", no "כעוזרת וירטואלית". Write like a real person on the business's team: simple everyday language, short natural sentences, no robotic service phrases ("אני כאן כדי לסייע", "אשמח לעמוד לשירותך"). If the customer DIRECTLY asks whether you are human or a bot: follow the business persona's scripted answer if it defines one; otherwise do not lie — answer briefly and lightly, then offer to keep helping or to hand off to a human.`;
// The deterministic backstop for this rule is stripWrappingQuotes
// (lib/outbound-text.js), applied where the model text is settled below.
const NO_QUOTE_WRAP_RULE = `Never wrap your entire reply in quotation marks of any kind — send the message text bare.`;

// ── Sales mode response ───────────────────────────────────────────────────────

async function generateSalesResponse({ message, business_profile, persona, hebrew_patterns, conversation_history, intent, cta_goal, guardrails, modules_context }) {
  const lang = intent.language ?? 'hebrew';
  const system = `You are a sales representative for this business. Sound 100% human — NEVER like AI.
Mode: SALES. Your goal is to qualify the lead and push toward: ${cta_goal}.
Use the persona's language patterns EXACTLY. Ask ONE question max. Keep it SHORT (1-4 sentences).
CTA decision: ${intent.cta_decision}.
Business info: ${JSON.stringify(business_profile)}
${GROUNDING_RULE}
${modules_context ? '\n' + modules_context + '\n' : ''}
${MISSING_DETAILS_RULE}
${ADDRESS_GENDER_RULE}
${AUTHENTICITY_RULE}
${NO_QUOTE_WRAP_RULE}${policyText(guardrails)}${identityText(persona)}
${langInstruction(lang, hebrew_patterns)}
Persona: ${JSON.stringify(persona)}`;

  return callClaude(system, conversation_history, message);
}

// ── Support mode response ─────────────────────────────────────────────────────

async function generateSupportResponse({ message, business_profile, persona, hebrew_patterns, conversation_history, intent, guardrails, modules_context }) {
  const lang = intent.language ?? 'hebrew';
  const system = `You are a customer support representative for this business. Sound 100% human — NEVER like AI.
Mode: SUPPORT. Your goal is to resolve the customer's question or issue fully.
Do NOT push sales or CTA. Focus entirely on helping them.
Be warm, clear, and concise. 1-4 sentences.
${GROUNDING_RULE}
${modules_context ? '\n' + modules_context + '\n' : ''}
${MISSING_DETAILS_RULE}
${ADDRESS_GENDER_RULE}
${AUTHENTICITY_RULE}
${NO_QUOTE_WRAP_RULE}${policyText(guardrails)}${identityText(persona)}
${langInstruction(lang, hebrew_patterns)}
Persona: ${JSON.stringify(persona)}
Business info: ${JSON.stringify(business_profile)}`;

  return callClaude(system, conversation_history, message);
}

// ── Hybrid mode response ──────────────────────────────────────────────────────

async function generateHybridResponse({ message, business_profile, persona, hebrew_patterns, conversation_history, intent, cta_goal, guardrails, modules_context }) {
  const lang = intent.language ?? 'hebrew';
  const isFrustrated = ['frustrated', 'angry'].includes(intent.sentiment);
  const isHighIntent = ['high_intent', 'ready_to_buy'].includes(intent.detected_intent);

  const system = `You are a representative for this business. Sound 100% human — NEVER like AI.
Mode: HYBRID. Follow this two-part structure:

Part 1 — Answer the question or concern fully and clearly (ALWAYS include this)
${isFrustrated
  ? 'Part 2 — Customer seems frustrated. Stay in support mode only. No sales nudge this turn.'
  : isHighIntent
    ? `Part 2 — Customer seems interested. Add a direct CTA toward: ${cta_goal}`
    : 'Part 2 — Add ONE soft forward-moving statement or gentle question (never a hard push)'}

Keep total response SHORT (2-5 sentences max). Sound natural.
${GROUNDING_RULE}
${modules_context ? '\n' + modules_context + '\n' : ''}
${MISSING_DETAILS_RULE}
${ADDRESS_GENDER_RULE}
${AUTHENTICITY_RULE}
${NO_QUOTE_WRAP_RULE}${policyText(guardrails)}${identityText(persona)}
${langInstruction(lang, hebrew_patterns)}
Persona: ${JSON.stringify(persona)}
Business info: ${JSON.stringify(business_profile)}`;

  return callClaude(system, conversation_history, message);
}

// ── Validation + rewrite ──────────────────────────────────────────────────────

async function validateAndFix({ candidate, persona, guardrails, intent, agent_mode }) {
  let text = candidate;
  let retries = 0;

  while (retries <= MAX_VALIDATION_RETRIES) {
    const issues = validate(text, guardrails, agent_mode);
    if (issues.length === 0) return { passed: true, text, rewrite_applied: retries > 0 };
    if (retries === MAX_VALIDATION_RETRIES) break;
    text = await rewrite({ text, issues, persona, guardrails, language: intent.language, agent_mode });
    retries++;
  }

  return { passed: false, text: '', rewrite_applied: true };
}

function validate(text, guardrails, agent_mode) {
  const issues = [];
  const words  = text.trim().split(/\s+/);

  if (words.length > 80) issues.push(`Too long: ${words.length} words (max 80)`);
  if ((text.match(/\?/g) ?? []).length > 1) issues.push('More than one question');

  // Forward motion only required for sales/hybrid
  if (agent_mode !== 'support' && words.length > 10 && !/([\?!]|book|call|schedule|contact|שלח|אשמח)/i.test(text)) {
    issues.push('No forward motion signal');
  }

  for (const phrase of guardrails?.forbidden_phrases ?? []) {
    if (text.toLowerCase().includes(phrase.toLowerCase())) issues.push(`Forbidden phrase: "${phrase}"`);
  }
  for (const phrase of GENERIC_AI_PHRASES) {
    if (text.toLowerCase().includes(phrase)) issues.push(`Generic AI phrase: "${phrase}"`);
  }

  return issues;
}

async function rewrite({ text, issues, persona, guardrails, language, agent_mode }) {
  // The rewrite never sees the conversation, so it cannot re-derive whether the
  // customer is a woman — it can only preserve what the original already got
  // right. Without this line a correctly-feminine reply comes back masculine.
  const prompt = `Rewrite this message to fix: ${issues.join('; ')}.
Keep the same intent. Sound human. Max 80 words. One question max.
Keep the Hebrew gender of address (masculine vs feminine second person) exactly as it is in the original — do not change who is being addressed or how.
Mode: ${agent_mode}. Tone: ${JSON.stringify(persona?.tone ?? 'warm')}.
Language: ${language}.
Forbidden: ${JSON.stringify(guardrails?.forbidden_phrases ?? [])}.
Original: "${text}"
Rewritten:`;

  const response = await createMessage({
    model: MODEL, max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });
  // The rewrite prompt shows the model `Original: "${text}"` — quotes around
  // it — which is exactly how a whole reply comes back quote-wrapped.
  return stripWrappingQuotes(response.content[0].text.trim());
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapCtaDecision(cta_decision, agent_mode) {
  if (agent_mode === 'support') {
    return { next_stage: 'support', action: 'none', cta_triggered: false };
  }
  const map = {
    cta:     { next_stage: 'cta',           action: 'commit', cta_triggered: true  },
    qualify: { next_stage: 'qualification', action: 'none',   cta_triggered: false },
    clarify: { next_stage: 'clarification', action: 'none',   cta_triggered: false },
    resolve: { next_stage: 'clarification', action: 'none',   cta_triggered: false },
    escalate:{ next_stage: 'escalated',     action: 'none',   cta_triggered: false },
  };
  return map[cta_decision] ?? map.clarify;
}

function langInstruction(lang, hebrew_patterns) {
  return lang !== 'english'
    ? `Respond in Hebrew or mixed Hebrew/English matching the user's language. Patterns: ${JSON.stringify(hebrew_patterns)}.`
    : 'Respond in English.';
}

async function callClaude(system, history, message) {
  const messages = [
    ...history.slice(-10).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: message },
  ];
  const response = await createMessage({
    model: MODEL, max_tokens: 512, system, messages,
  });
  // Live pilot 2026-08-12: a perfect reply arrived wrapped in quotation marks.
  // NO_QUOTE_WRAP_RULE asks the model not to; this settles it either way.
  return stripWrappingQuotes(response.content[0].text.trim());
}

// ── Human-like reply delay ────────────────────────────────────────────────────
// Mimics real typing time so the conversation feels natural, not instant-bot

async function humanDelay(text, answerLength, startedAt) {
  const ms = replyDelayMs({
    words: (text ?? '').split(/\s+/).length,
    answerLength,
    elapsedMs: startedAt ? Date.now() - startedAt : 0,
  });
  if (ms > 0) await new Promise(r => setTimeout(r, ms));
}

function ok(result) { return { status: 'success', result, error: null }; }


