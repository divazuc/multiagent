// WA_03 + WA_05 replacement — intent detection, response generation, validation
// Supports three agent modes: sales / support / hybrid

import Anthropic from '@anthropic-ai/sdk';
import { replyDelayMs } from '../lib/reply-delay.js';
import { extractModuleAction } from '../lib/modules/actions.js';
import { stripWrappingQuotes } from '../lib/outbound-text.js';
import { extractUsage, sumUsage } from '../lib/model-usage.js';
import { retrieveTopK, formatKbContextBlock, splitCoreRows, formatCoreKbBlock } from '../lib/kb-retrieval.js';
import { matchDirectKb, matchMultiDirectKb } from '../lib/kb-direct-match.js';
import { alertCreditExhaustion } from '../lib/credit-alert.js';

// Owner, 2026-08-29: one reply took 2m22s inside the model calls (Diva Ost E2E).
// The SDK's defaults — a 10-minute timeout and 2 retries with backoff — turn an
// API stall into minutes of silence on WhatsApp. Bound the live client: a slow
// call fails fast and the pipeline's holding line goes out instead. 25s is well
// above a normal Sonnet turn here (~4-8s) and below anyone's patience.
export const CONVERSATION_CLIENT_OPTIONS = Object.freeze({ timeout: 25_000, maxRetries: 1 });
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, ...CONVERSATION_CLIENT_OPTIONS });
const MODEL  = 'claude-sonnet-4-6';

// Cost-efficiency pass (2026-08-12), item 5: business_profiles.persona.
// conversation_model lets one business run a different model for its own
// conversation turns (the owner's kids-business quality trial on Haiku) —
// validated against this allow-list so a typo or a stale model id in the
// jsonb can never reach the API; it just falls back to the default MODEL.
const ALLOWED_CONVERSATION_MODELS = new Set(['claude-sonnet-4-6', 'claude-haiku-4-5-20251001']);
function resolveModel(persona) {
  const override = persona?.conversation_model;
  return ALLOWED_CONVERSATION_MODELS.has(override) ? override : MODEL;
}

// Test seam for the model call — same convention as lib/relay/index.js. Every
// branch of runConversation is gated behind detectIntent, so without this the
// escalation wiring below could only ever be asserted by grepping the source.
// It is exactly that gap that let a guard on a non-existent key ship as a
// production no-op.
let messagesCreate = null;
export function _setMessagesCreateForTest(fn) { messagesCreate = fn; }
// Cost-efficiency pass, item 1: every call that goes through here records its
// usage into the caller-supplied usageLog (if any) — one hook instead of
// duplicating the extractUsage() call at each of the three call sites below.
async function createMessage(params, usageLog) {
  const response = messagesCreate ? await messagesCreate(params) : await client.messages.create(params);
  if (usageLog && response?.usage) usageLog.push(extractUsage(response.usage, params.model));
  return response;
}

const MAX_VALIDATION_RETRIES = 2;
const GENERIC_AI_PHRASES = [
  'certainly', 'of course', 'absolutely', 'as an ai', 'i am an ai', 'i cannot',
  // Hebrew AI-isms (owner feedback 2026-08-21: "מרגיש AI מדי") — toLowerCase is a
  // no-op for Hebrew so plain includes() works.
  'כעוזרת וירטואלית', 'כעוזר וירטואלי', 'כבינה מלאכותית', 'כמודל שפה',
  'אני מודל שפה', 'אני בוט', 'אני רק בוט', 'איני יכולה לספק', 'איני יכול לספק',
];

// Links the bot already sent in this conversation — the once-per-conversation
// brake for CTA links (owner feedback 2026-08-21: the trial link was pushed four
// times in one short chat).
const URL_RE = /https?:\/\/\S+/g;
function extractSentLinks(history = []) {
  const links = new Set();
  for (const m of history) {
    if (m.role !== 'assistant') continue;
    for (const u of String(m.content ?? '').match(URL_RE) ?? []) {
      links.add(u.replace(/[).,!?׃:]+$/, ''));
    }
  }
  return [...links];
}

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
    const model = resolveModel(persona);
    const usageLog = [];

    // ── Step 0: Direct-KB short-circuit (item 4, extended 2026-08-13) — zero
    // model cost. Runs BEFORE intent detection. Two independent shapes, tried
    // in this order — they never compete for the same message, since a
    // multi-question message (2-3 '?') can never pass the single-question
    // standalone-shape gate matchDirectKb requires:
    //   - matchMultiDirectKb: every segment of a 2-3-part message near-exact-
    //     matches a DIFFERENT stored question -> one WhatsApp message per
    //     segment (extra_messages), still zero model calls. Any miss (or a
    //     segment count outside 2-3) falls all the way through to the normal
    //     COMBINED-message model path below — never a per-segment model call.
    //     Segments that all land on the SAME row collapse into one ordinary
    //     direct answer instead of repeating it.
    //   - matchDirectKb: the single-question path. A NEAR-EXACT match now
    //     fires mid-conversation too ("תשובות חוזרות" — the real saving); the
    //     looser scoring-margin tier still requires empty history. See
    //     lib/kb-direct-match.js.
    const kbRows = business_profile?.knowledge?.items ?? [];
    const historyNonTrivial = (conversation_history?.length ?? 0) > 0;

    let kbHit = null;       // { question, answer } — the first/main answer
    let kbExtraHits = [];   // [{ question, answer }, ...] — sent as extra_messages
    let pinnedKbRow = null; // mid-conversation near-exact hit, answered via the model

    const multiHit = matchMultiDirectKb({ message, rows: kbRows });
    if (multiHit?.multi) {
      [kbHit, ...kbExtraHits] = multiHit.hits;
    } else if (multiHit) {
      kbHit = { question: multiHit.question, answer: multiHit.answer };
    } else {
      kbHit = matchDirectKb({ message, rows: kbRows, historyNonTrivial });
      // Mid-conversation, a near-exact hit is no longer returned VERBATIM — a
      // canned DB string in the middle of a warm chat reads robotic (owner
      // feedback 2026-08-21). The matched row is pinned into the model call
      // instead: same facts, the persona's voice. First-message hits (the
      // classic FAQ opener) still short-circuit at zero model cost.
      if (kbHit && historyNonTrivial) {
        pinnedKbRow = kbHit;
        kbHit = null;
      }
    }

    if (kbHit) {
      const [answerText, ...extraTexts] = [kbHit, ...kbExtraHits]
        .map((hit) => stripWrappingQuotes(String(hit.answer ?? '')));
      const answerLength = business_profile?.answer_length ?? persona?.answer_length ?? 'short';
      // The reply-delay budget is measured against the FIRST message only —
      // extras get a short human-feeling gap instead (index.js, at send time).
      await humanDelay(answerText, answerLength, startedAt);
      return ok({
        response: answerText,
        ...(extraTexts.length ? { extra_messages: extraTexts } : {}),
        next_stage: current_stage ?? 'clarification', action: 'none', cta_triggered: false,
        escalate: false, escalation_reason: null,
        qualification_progress: context.qualification_progress ?? {},
        language: detectMessageLanguage(message),
        kb_direct: {
          matched: true,
          question: kbHit.question,
          questions: [kbHit, ...kbExtraHits].map((hit) => hit.question),
        },
        model_usage: [], model_usage_total: sumUsage([]),
      });
    }

    // ── Step 1: Detect intent ─────────────────────────────────────────────────
    const intent = await detectIntent({
      message, business_profile, missing_qualification_data,
      conversation_history, current_stage, agent_mode, guardrails,
      has_modules: !!context.modules_context, model, usageLog,
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
      let phrase = relayed?.holdingLine
        ?? persona?.escalation_phrase
        ?? (persona?.bot_gender === 'male' ? 'אני מעביר אותך לנציג שלנו כעת.' : 'אני מעבירה אותך לנציגה שלנו כעת.');
      // Already-escalated conversations must not get the SAME canned line for
      // every further message (owner feedback 2026-08-21: three identical
      // replies in a row, including to "שמי ליאת"). One tiny model call turns
      // it into a varied human acknowledgement; any failure falls back to the
      // canned phrase — never worse than before. Applies whenever there is
      // real conversation context — mid-chat, the canned opener reads wrong
      // even on a FIRST escalation ("בסדר אתאם!" → "אני אבדוק עם המאמנת"), and
      // the customer's message often carries details worth acknowledging.
      if (current_stage === 'escalated' || (conversation_history?.length ?? 0) >= 2) {
        try {
          phrase = await generateEscalatedAck({
            message, persona, business_profile, conversation_history,
            language: intent.language ?? 'hebrew', model, usageLog,
          });
        } catch { /* keep the canned phrase */ }
      }
      return ok({
        response: phrase, next_stage: 'escalated', action: 'none',
        cta_triggered: false, escalate: true,
        escalation_reason: intent.escalation_reason,
        qualification_progress: intent.qualification_progress ?? context.qualification_progress ?? {},
        language: intent.language ?? 'hebrew',
        model_usage: usageLog, model_usage_total: sumUsage(usageLog),
      });
    }

    // ── Step 2: Generate response based on mode ───────────────────────────────
    let candidate;

    const modules_context = context.modules_context ?? null;
    // Owner incident 2026-08-13: rows marked 'core' (schedule, pricing, the
    // trial-form link) are exempt from retrieval — they ride in the STABLE
    // cached block so they are ALWAYS visible regardless of how the customer
    // phrased the message. Retrieval runs over the remaining rows only.
    const { core: coreKbRows, rest: restKbRows } = splitCoreRows(kbRows);
    const coreKbText = formatCoreKbBlock(coreKbRows);
    let kbContext = buildKbContext({
      message, kbRows: restKbRows, faqSummary: coreKbRows.length ? null : (business_profile?.knowledge?.faq_summary ?? null),
    });
    if (pinnedKbRow) {
      kbContext = `Matched FAQ — answer using exactly these facts, phrased naturally in your own voice:\nQ: ${pinnedKbRow.question}\nA: ${pinnedKbRow.answer}${kbContext ? '\n' + kbContext : ''}`;
    }

    if (agent_mode === 'support') {
      candidate = await generateSupportResponse({ message, business_profile, persona, hebrew_patterns, conversation_history, intent, guardrails, modules_context, kbContext, coreKbText, model, usageLog });
    } else if (agent_mode === 'hybrid') {
      candidate = await generateHybridResponse({ message, business_profile, persona, hebrew_patterns, conversation_history, intent, cta_goal, guardrails, modules_context, kbContext, coreKbText, model, usageLog });
    } else {
      candidate = await generateSalesResponse({ message, business_profile, persona, hebrew_patterns, conversation_history, intent, cta_goal, guardrails, modules_context, kbContext, coreKbText, model, usageLog });
    }

    // Modules: the model may append an ACTION marker — extract it BEFORE
    // validation so the rewrite loop never sees or mangles the marker.
    const extracted = extractModuleAction(candidate);
    candidate = extracted.text;

    // ── Step 3: Validate + rewrite loop ───────────────────────────────────────
    const validated = await validateAndFix({ candidate, persona, guardrails, intent, agent_mode, model, usageLog, conversation_history });

    if (!validated.passed) {
      // The customer must never get SILENCE (sim finding 2026-08-21: a warm,
      // slightly-too-long empathy answer failed validation twice and the reply
      // came back empty). The holding line is the safe floor — the content that
      // failed validation is still discarded.
      const holdingPhrase = persona?.escalation_phrase
        ?? (persona?.bot_gender === 'male' ? 'אני אבדוק את זה ואחזור אליך בהקדם 🙂' : 'אני אבדוק את זה ואחזור אלייך בהקדם 🙂');
      return ok({
        response: holdingPhrase, next_stage: 'escalated', action: 'none',
        cta_triggered: false, escalate: true,
        escalation_reason: 'Response failed validation after max retries',
        qualification_progress: intent.qualification_progress ?? {},
        language: intent.language ?? 'hebrew',
        model_usage: usageLog, model_usage_total: sumUsage(usageLog),
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
      model_usage: usageLog, model_usage_total: sumUsage(usageLog),
    });

  } catch (e) {
    // Item 6: a credit-exhaustion 400 from any of the calls above bubbles up
    // here — this is the one place that catches every one of them.
    await alertCreditExhaustion(e).catch(() => {});
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

// Cost-efficiency pass, item 2: the JSON dump of business_profile that goes
// into every prompt (stable prefix AND the intent-detection call) must never
// carry `knowledge` — that's the ~45-row faq_summary text this whole pass
// exists to stop paying for on every message. Retrieval (kb-retrieval.js)
// and the fallback (buildKbContext below) put whatever's actually relevant
// into the DYNAMIC tail instead.
function businessProfileForPrompt(business_profile) {
  const { knowledge, ...rest } = business_profile ?? {};
  return rest;
}

// Cost-efficiency pass, item 3: the compact, per-turn KB block for the
// dynamic tail. Empty kbRows (no structured knowledge_items for this
// business, or the retrieval call itself throwing) is the ONLY thing that
// falls back to dumping the full faq_summary text, exactly as before this
// pass — a query that legitimately matches nothing does NOT fall back, or
// every "hi" would re-pay the full dump this feature removes.
function buildKbContext({ message, kbRows, faqSummary }) {
  try {
    if (kbRows?.length) {
      const scored = retrieveTopK({ message, rows: kbRows, topK: 8 });
      return scored.length ? formatKbContextBlock(scored) : '';
    }
  } catch (e) {
    console.error('[kb-retrieval] failed, falling back to full faq_summary:', e.message);
  }
  return faqSummary ? legacyFaqBlock(faqSummary) : '';
}

function legacyFaqBlock(faqSummary) {
  return `Business knowledge (FAQ):\n${faqSummary}\n\nאם אין במידע תשובה — אל תמציא.`;
}

// Rough language guess for the direct-KB path, which never calls the model
// (so there is no intent.language to read). Good enough for the language
// column on the saved conversation row; the reply itself is the stored
// answer verbatim, unaffected either way.
function detectMessageLanguage(message) {
  return /[֐-׿]/.test(String(message ?? '')) ? 'hebrew' : 'english';
}

async function detectIntent({ message, business_profile, missing_qualification_data, conversation_history, current_stage, agent_mode, guardrails, has_modules, model, usageLog }) {
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

  const userPrompt = `Business: ${JSON.stringify(businessProfileForPrompt(business_profile))}
Missing qualification: ${JSON.stringify(missing_qualification_data)}
History: ${JSON.stringify(conversation_history.slice(-6))}
Stage: ${current_stage}
Message: "${message}"`;

  const response = await createMessage({
    model, max_tokens: 1024,
    system, messages: [{ role: 'user', content: userPrompt }],
  }, usageLog);

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

function hebrewPatternsText(hebrew_patterns) {
  return `Hebrew language patterns to use when responding in Hebrew: ${JSON.stringify(hebrew_patterns ?? {})}`;
}

// ── Sales mode response ───────────────────────────────────────────────────────

async function generateSalesResponse({ message, business_profile, persona, hebrew_patterns, conversation_history, intent, cta_goal, guardrails, modules_context, kbContext, coreKbText, model, usageLog }) {
  const lang = intent.language ?? 'hebrew';
  // STABLE prefix — cost-efficiency pass item 2: byte-identical across every
  // turn of the SAME business (no per-turn interpolation in here — cta_goal,
  // guardrails, persona and the core-KB block only change when the owner
  // edits her profile/KB, not per message). Marked cache_control in callClaude().
  const stableText = `You are a sales representative for this business. Sound 100% human — NEVER like AI.
Mode: SALES. Your goal is to qualify the lead and push toward: ${cta_goal}.
Use the persona's language patterns EXACTLY. Ask ONE question max. Keep it SHORT (1-4 sentences).
Business info: ${JSON.stringify(businessProfileForPrompt(business_profile))}
${GROUNDING_RULE}
${MISSING_DETAILS_RULE}
${ADDRESS_GENDER_RULE}
${AUTHENTICITY_RULE}
${NO_QUOTE_WRAP_RULE}${policyText(guardrails)}${identityText(persona)}
${hebrewPatternsText(hebrew_patterns)}
Persona: ${JSON.stringify(persona)}${coreKbText ? '\n' + coreKbText : ''}`;

  // DYNAMIC tail — everything that varies turn to turn: this turn's CTA
  // decision, live module state, the retrieved KB rows for THIS question,
  // and the language switch.
  const dynamicText = `CTA decision: ${intent.cta_decision}.
${modules_context ? '\n' + modules_context + '\n' : ''}
${kbContext ? '\n' + kbContext + '\n' : ''}
${langInstruction(lang)}`;

  return callClaude(stableText, dynamicText, conversation_history, message, model, usageLog);
}

// ── Support mode response ─────────────────────────────────────────────────────

async function generateSupportResponse({ message, business_profile, persona, hebrew_patterns, conversation_history, intent, guardrails, modules_context, kbContext, coreKbText, model, usageLog }) {
  const lang = intent.language ?? 'hebrew';
  const stableText = `You are a customer support representative for this business. Sound 100% human — NEVER like AI.
Mode: SUPPORT. Your goal is to resolve the customer's question or issue fully.
Do NOT push sales or CTA. Focus entirely on helping them.
Be warm, clear, and concise. 1-4 sentences.
${GROUNDING_RULE}
${MISSING_DETAILS_RULE}
${ADDRESS_GENDER_RULE}
${AUTHENTICITY_RULE}
${NO_QUOTE_WRAP_RULE}${policyText(guardrails)}${identityText(persona)}
${hebrewPatternsText(hebrew_patterns)}
Persona: ${JSON.stringify(persona)}
Business info: ${JSON.stringify(businessProfileForPrompt(business_profile))}${coreKbText ? '\n' + coreKbText : ''}`;

  const dynamicText = `${modules_context ? '\n' + modules_context + '\n' : ''}
${kbContext ? '\n' + kbContext + '\n' : ''}
${langInstruction(lang)}`;

  return callClaude(stableText, dynamicText, conversation_history, message, model, usageLog);
}

// ── Hybrid mode response ──────────────────────────────────────────────────────

async function generateHybridResponse({ message, business_profile, persona, hebrew_patterns, conversation_history, intent, cta_goal, guardrails, modules_context, kbContext, coreKbText, model, usageLog }) {
  const lang = intent.language ?? 'hebrew';
  const isFrustrated = ['frustrated', 'angry'].includes(intent.sentiment);
  const isHighIntent = ['high_intent', 'ready_to_buy'].includes(intent.detected_intent);

  // The Part-1/Part-2 STRUCTURE is stable; WHICH Part-2 branch applies is
  // per-turn (depends on this message's detected sentiment/intent), so the
  // actual branch text lives in the dynamic tail below, not here.
  const stableText = `You are a representative for this business. Sound 100% human — NEVER like AI.
Mode: HYBRID. Follow a two-part structure every turn: Part 1 always answers the question or concern fully and clearly. Part 2 is decided per message by this turn's instructions below.
Keep total response SHORT (2-5 sentences max). Sound natural.
${GROUNDING_RULE}
${MISSING_DETAILS_RULE}
${ADDRESS_GENDER_RULE}
${AUTHENTICITY_RULE}
${NO_QUOTE_WRAP_RULE}${policyText(guardrails)}${identityText(persona)}
${hebrewPatternsText(hebrew_patterns)}
Persona: ${JSON.stringify(persona)}
Business info: ${JSON.stringify(businessProfileForPrompt(business_profile))}${coreKbText ? '\n' + coreKbText : ''}`;

  // Once-per-conversation CTA brake: a link the bot already sent must never be
  // sent again, and after the customer agreed (or brushed off with a short
  // reaction) the right move is a warm close, not another pitch.
  const sentLinks = extractSentLinks(conversation_history);
  const linkNote = sentLinks.length
    ? `\nAlready sent in this conversation (NEVER send again, NEVER re-offer): ${sentLinks.join(' ')}`
    : '';

  const part2 = isFrustrated
    ? 'Part 2 — Customer seems frustrated. Stay in support mode only. No sales nudge this turn.'
    : isHighIntent
      ? (sentLinks.length
          ? 'Part 2 — Customer is interested and the signup link was ALREADY sent. Confirm warmly and close — no link, no repeated offer.'
          : `Part 2 — Customer seems interested. Add a direct CTA toward: ${cta_goal}`)
      : 'Part 2 — Continue the conversation naturally. Only if it genuinely helps, add ONE soft forward-moving statement or gentle question — never a hard push. Short reactions (laughter, emoji, "ואי", acknowledgements) get a light human reply with NO sales nudge at all.';

  const dynamicText = `${part2}${linkNote}
${modules_context ? '\n' + modules_context + '\n' : ''}
${kbContext ? '\n' + kbContext + '\n' : ''}
${langInstruction(lang)}`;

  return callClaude(stableText, dynamicText, conversation_history, message, model, usageLog);
}

// ── Validation + rewrite ──────────────────────────────────────────────────────

async function validateAndFix({ candidate, persona, guardrails, intent, agent_mode, model, usageLog, conversation_history }) {
  let text = candidate;
  let retries = 0;
  const linkAlreadySent = extractSentLinks(conversation_history).length > 0;

  while (retries <= MAX_VALIDATION_RETRIES) {
    const issues = validate(text, guardrails, agent_mode, { linkAlreadySent });
    if (issues.length === 0) return { passed: true, text, rewrite_applied: retries > 0 };
    if (retries === MAX_VALIDATION_RETRIES) break;
    text = await rewrite({ text, issues, persona, guardrails, language: intent.language, agent_mode, model, usageLog });
    retries++;
  }

  return { passed: false, text: '', rewrite_applied: true };
}

function validate(text, guardrails, agent_mode, { linkAlreadySent = false } = {}) {
  const issues = [];
  const words  = text.trim().split(/\s+/);

  if (words.length > 80) issues.push(`Too long: ${words.length} words (max 80)`);
  if ((text.match(/\?/g) ?? []).length > 1) issues.push('More than one question');

  // Forward motion only required for sales/hybrid — and only for substantial
  // replies. The old 10-word bar forced a persona-less rewrite onto perfectly
  // calm answers (owner feedback 2026-08-21: pushy + flattened tone), and a
  // reply whose forward motion IS a link ("מחכים לך בטופס: https://…") failed
  // it too. Once the CTA link was already delivered in this conversation, a
  // reply with no fresh nudge is exactly right — no issue at all.
  if (agent_mode !== 'support' && !linkAlreadySent && words.length > 25 &&
      !/([\?!]|https?:\/\/|book|call|schedule|contact|שלח|אשמח)/i.test(text)) {
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

async function rewrite({ text, issues, persona, guardrails, language, agent_mode, model, usageLog }) {
  // The rewrite never sees the conversation, so it cannot re-derive whether the
  // customer is a woman — it can only preserve what the original already got
  // right. Without this line a correctly-feminine reply comes back masculine.
  // The rewrite must keep the PERSONA's voice — a rewrite that only knows
  // "Tone: warm" strips the character out of the reply (owner feedback
  // 2026-08-21: rewritten replies read flat and AI-ish).
  const prompt = `Rewrite this message to fix: ${issues.join('; ')}.
Keep the same intent. Sound 100% human — never like AI. Max 80 words. One question max.
Keep the Hebrew gender of address (masculine vs feminine second person) exactly as it is in the original — do not change who is being addressed or how.
Mode: ${agent_mode}. Tone: ${JSON.stringify(persona?.tone ?? 'warm')}.
${identityText(persona)}
Persona style: ${JSON.stringify(persona?.style_notes ?? '')}
CTA policy: ${JSON.stringify(persona?.cta_style ?? '')}
Language: ${language}.
Forbidden: ${JSON.stringify(guardrails?.forbidden_phrases ?? [])}.
Original: "${text}"
Rewritten:`;

  const response = await createMessage({
    model, max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  }, usageLog);
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

function langInstruction(lang) {
  return lang !== 'english'
    ? `Respond in Hebrew or mixed Hebrew/English matching the user's language, using the Hebrew language patterns given above.`
    : 'Respond in English.';
}

// Cost-efficiency pass, item 2: system is now an array of two blocks — a
// STABLE prefix carrying cache_control (so a second turn of the same
// business reads it from cache instead of re-processing it), and a small
// DYNAMIC tail with no cache_control at all (it's never worth caching —
// see each generate*Response above for what's stable vs dynamic and why).
async function callClaude(stableText, dynamicText, history, message, model, usageLog) {
  const messages = [
    ...history.slice(-10).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: message },
  ];
  const system = [
    { type: 'text', text: stableText, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: dynamicText },
  ];
  const response = await createMessage({
    model, max_tokens: 512, system, messages,
  }, usageLog);
  // Live pilot 2026-08-12: a perfect reply arrived wrapped in quotation marks.
  // NO_QUOTE_WRAP_RULE asks the model not to; this settles it either way.
  return stripWrappingQuotes(response.content[0].text.trim());
}

// ── Already-escalated acknowledgement ────────────────────────────────────────
// The conversation is with the coach already; the customer just added another
// message (their name, a phone number, more context). One short varied human
// sentence instead of repeating the holding line verbatim.
// WHO the customer is handed to is the tenant's fact, in the tenant's words.
// Owner, 2026-08-29: the kids bot's "coach" had been hard-coded into this shared
// prompt, and Diva Ost's business bot told a client "העברתי למאמן". Every tenant
// already states its own handoff in persona.escalation_phrase; the profile's
// contact_name is the fallback, and a nameless business hands off to a neutral
// person — never to a role borrowed from another business.
export function buildEscalatedAckPrompt({ message, persona, business_profile, conversation_history, language }) {
  const historyTail = (conversation_history ?? []).slice(-6)
    .map(m => `${m.role === 'assistant' ? 'REP' : 'CUSTOMER'}: ${m.content}`).join('\n');
  const ownLine = typeof persona?.escalation_phrase === 'string' && persona.escalation_phrase.trim()
    ? persona.escalation_phrase.trim() : null;
  const contact = typeof business_profile?.contact_name === 'string' && business_profile.contact_name.trim()
    ? business_profile.contact_name.trim() : null;
  const handoff = ownLine
    ? `The business describes the handoff in its own words — keep to exactly who that line names: "${ownLine}"`
    : contact
      ? `The customer is being handed to ${contact}, who will get back to them.`
      : 'The customer is being handed to the person in charge at the business, who will get back to them.';
  return `This conversation is being handed off to a human at the business (it may already have been earlier).
${identityText(persona)}
${handoff}
Write ONE short, warm, human sentence in ${language === 'english' ? 'English' : 'Hebrew'} that fits the customer's LATEST message: acknowledge it, and if it contains a name, phone number or preference — confirm those were passed on (address them by name when you have it). Name the person exactly as the business does above — never invent a role or title for them. No questions, no links, no sales, and never reuse a sentence that already appears in the conversation.
Conversation:
${historyTail}
Customer's new message: ${message}
Reply:`;
}

async function generateEscalatedAck({ message, persona, business_profile, conversation_history, language, model, usageLog }) {
  const prompt = buildEscalatedAckPrompt({ message, persona, business_profile, conversation_history, language });
  const response = await createMessage({
    model, max_tokens: 120,
    messages: [{ role: 'user', content: prompt }],
  }, usageLog);
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

