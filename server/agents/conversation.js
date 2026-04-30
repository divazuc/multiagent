// WA_03 + WA_05 replacement — intent detection, response generation, validation
// Supports three agent modes: sales / support / hybrid

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL  = 'claude-sonnet-4-6';

const MAX_VALIDATION_RETRIES = 2;
const GENERIC_AI_PHRASES = ['certainly', 'of course', 'absolutely', 'as an ai', 'i am an ai', 'i cannot'];

export async function runConversation({ message, session_id, context }) {
  try {
    const {
      business_profile, persona, guardrails, hebrew_patterns,
      conversation_history, missing_qualification_data, current_stage,
    } = context;

    const agent_mode = business_profile?.agent_mode ?? context.agent_mode ?? 'sales';
    const cta_goal   = business_profile?.cta_goal   ?? context.cta_goal   ?? 'book_call';

    // ── Step 1: Detect intent ─────────────────────────────────────────────────
    const intent = await detectIntent({
      message, business_profile, missing_qualification_data,
      conversation_history, current_stage, agent_mode,
    });

    // Hard escalation — all modes
    if (intent.escalate) {
      const phrase = persona?.escalation_phrase ?? 'אני מעביר אותך לנציג שלנו כעת.';
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

    if (agent_mode === 'support') {
      candidate = await generateSupportResponse({ message, business_profile, persona, hebrew_patterns, conversation_history, intent });
    } else if (agent_mode === 'hybrid') {
      candidate = await generateHybridResponse({ message, business_profile, persona, hebrew_patterns, conversation_history, intent, cta_goal });
    } else {
      candidate = await generateSalesResponse({ message, business_profile, persona, hebrew_patterns, conversation_history, intent, cta_goal });
    }

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

    return ok({
      response: validated.text,
      next_stage, action, cta_triggered,
      escalate: false, escalation_reason: null,
      qualification_progress: intent.qualification_progress ?? {},
      language: intent.language ?? 'hebrew',
      rewrite_applied: validated.rewrite_applied,
    });

  } catch (e) {
    return { status: 'error', result: null, error: e.message };
  }
}

// ── Intent detection ──────────────────────────────────────────────────────────

async function detectIntent({ message, business_profile, missing_qualification_data, conversation_history, current_stage, agent_mode }) {
  const modeInstruction = {
    sales:   'Bias toward CTA opportunities. Identify qualification gaps and push toward conversion.',
    support: 'Bias toward resolution. Focus on what the customer needs answered or resolved.',
    hybrid:  'Balance resolution with opportunity. Note if customer seems interested after their question.',
  }[agent_mode] ?? '';

  const system = `You are an intent detection engine for a WhatsApp business agent.
${modeInstruction}
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

  const response = await client.messages.create({
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

// ── Sales mode response ───────────────────────────────────────────────────────

async function generateSalesResponse({ message, business_profile, persona, hebrew_patterns, conversation_history, intent, cta_goal }) {
  const lang = intent.language ?? 'hebrew';
  const system = `You are a sales representative for this business. Sound 100% human — NEVER like AI.
Mode: SALES. Your goal is to qualify the lead and push toward: ${cta_goal}.
Use the persona's language patterns EXACTLY. Ask ONE question max. Keep it SHORT (1-4 sentences).
CTA decision: ${intent.cta_decision}.
${langInstruction(lang, hebrew_patterns)}
Persona: ${JSON.stringify(persona)}`;

  return callClaude(system, conversation_history, message);
}

// ── Support mode response ─────────────────────────────────────────────────────

async function generateSupportResponse({ message, business_profile, persona, hebrew_patterns, conversation_history, intent }) {
  const lang = intent.language ?? 'hebrew';
  const system = `You are a customer support representative for this business. Sound 100% human — NEVER like AI.
Mode: SUPPORT. Your goal is to resolve the customer's question or issue fully.
Do NOT push sales or CTA. Focus entirely on helping them.
Be warm, clear, and concise. 1-4 sentences.
${langInstruction(lang, hebrew_patterns)}
Persona: ${JSON.stringify(persona)}
Business info: ${JSON.stringify(business_profile)}`;

  return callClaude(system, conversation_history, message);
}

// ── Hybrid mode response ──────────────────────────────────────────────────────

async function generateHybridResponse({ message, business_profile, persona, hebrew_patterns, conversation_history, intent, cta_goal }) {
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
  const prompt = `Rewrite this message to fix: ${issues.join('; ')}.
Keep the same intent. Sound human. Max 80 words. One question max.
Mode: ${agent_mode}. Tone: ${JSON.stringify(persona?.tone ?? 'warm')}.
Language: ${language}.
Forbidden: ${JSON.stringify(guardrails?.forbidden_phrases ?? [])}.
Original: "${text}"
Rewritten:`;

  const response = await client.messages.create({
    model: MODEL, max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });
  return response.content[0].text.trim();
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
  const response = await client.messages.create({
    model: MODEL, max_tokens: 512, system, messages,
  });
  return response.content[0].text.trim();
}

function ok(result) { return { status: 'success', result, error: null }; }
