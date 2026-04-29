// WA_03 + WA_05 replacement — intent detection, response generation, validation + rewrite

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';

const MAX_VALIDATION_RETRIES = 2;
const GENERIC_AI_PHRASES = ['certainly', 'of course', 'absolutely', 'as an ai', 'i am an ai', 'i cannot'];

export async function runConversation({ message, session_id, context }) {
  try {
    const { business_profile, persona, guardrails, hebrew_patterns, conversation_history, missing_qualification_data, current_stage } = context;

    // ── Step 1: Intent detection + qualification analysis ─────────────────────
    const intentAnalysis = await detectIntent({ message, business_profile, missing_qualification_data, conversation_history, current_stage });

    if (intentAnalysis.escalate) {
      const escalationPhrase = persona?.escalation_phrase ?? 'אני מעביר אותך לנציג שלנו כעת.';
      return ok({ response: escalationPhrase, next_stage: 'escalated', action: 'none', cta_triggered: false, escalate: true, escalation_reason: intentAnalysis.escalation_reason, qualification_progress: intentAnalysis.qualification_progress ?? context.qualification_progress ?? {}, language: intentAnalysis.language ?? 'hebrew' });
    }

    // ── Step 2: Generate candidate response ───────────────────────────────────
    const candidate = await generateResponse({ message, business_profile, persona, hebrew_patterns, conversation_history, intentAnalysis });

    // ── Step 3: Validate + rewrite loop (WA_05) ───────────────────────────────
    const validated = await validateAndFix({ candidate, persona, guardrails, intentAnalysis });

    if (!validated.passed) {
      return ok({ response: '', next_stage: 'escalated', action: 'none', cta_triggered: false, escalate: true, escalation_reason: 'Response failed validation after max retries', qualification_progress: intentAnalysis.qualification_progress ?? {}, language: intentAnalysis.language ?? 'hebrew' });
    }

    const { next_stage, action, cta_triggered } = mapCtaDecision(intentAnalysis.cta_decision);

    return ok({
      response: validated.text,
      next_stage,
      action,
      cta_triggered,
      escalate: false,
      escalation_reason: null,
      qualification_progress: intentAnalysis.qualification_progress ?? {},
      language: intentAnalysis.language ?? 'hebrew',
      rewrite_applied: validated.rewrite_applied,
    });

  } catch (e) {
    return { status: 'error', result: null, error: e.message };
  }
}

// ── Intent detection ──────────────────────────────────────────────────────────

async function detectIntent({ message, business_profile, missing_qualification_data, conversation_history, current_stage }) {
  const systemPrompt = `You are an intent detection engine for a WhatsApp sales agent.
Analyze the user's message and return ONLY valid JSON with these fields:
- detected_intent: "high_intent" | "info_seeking" | "objection" | "unclear" | "human_request" | "ready_to_buy"
- language: "hebrew" | "english" | "mixed"
- urgency: "low" | "medium" | "high"
- cta_decision: "cta" | "qualify" | "clarify" | "escalate"
- qualification_complete: boolean
- missing_fields: array of strings
- escalate: boolean
- escalation_reason: string or null
- qualification_progress: object with keys need/scope/budget/timeline/urgency (null if unknown)`;

  const userPrompt = `Business: ${JSON.stringify(business_profile)}
Missing qualification data: ${JSON.stringify(missing_qualification_data)}
Conversation history: ${JSON.stringify(conversation_history.slice(-6))}
Current stage: ${current_stage}
Latest message: "${message}"`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt,
  });

  try {
    const text = response.content[0].text.replace(/```json\n?|\n?```/g, '').trim();
    return JSON.parse(text);
  } catch {
    return { detected_intent: 'unclear', language: 'hebrew', urgency: 'low', cta_decision: 'clarify', escalate: false, qualification_progress: {} };
  }
}

// ── Response generation ───────────────────────────────────────────────────────

async function generateResponse({ message, business_profile, persona, hebrew_patterns, conversation_history, intentAnalysis }) {
  const lang = intentAnalysis.language ?? 'hebrew';
  const hebrewInstruction = lang !== 'english'
    ? `Respond in Hebrew or mixed Hebrew/English matching the user's language. Use these Hebrew patterns: ${JSON.stringify(hebrew_patterns)}.`
    : 'Respond in English.';

  const systemPrompt = `You are a sales representative for this business. Sound 100% human — NEVER like AI.
Use the persona's language patterns EXACTLY. Ask ONE question maximum. Keep it SHORT (1-4 sentences).
CTA decision: ${intentAnalysis.cta_decision}. ${hebrewInstruction}
Persona: ${JSON.stringify(persona)}`;

  const history = conversation_history.slice(-10).map(m => ({ role: m.role, content: m.content }));
  history.push({ role: 'user', content: message });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: systemPrompt,
    messages: history,
  });

  return response.content[0].text.trim();
}

// ── Validation + rewrite loop (WA_05) ────────────────────────────────────────

async function validateAndFix({ candidate, persona, guardrails, intentAnalysis }) {
  let text = candidate;
  let retries = 0;

  while (retries <= MAX_VALIDATION_RETRIES) {
    const issues = validate(text, guardrails);
    if (issues.length === 0) return { passed: true, text, rewrite_applied: retries > 0 };

    if (retries === MAX_VALIDATION_RETRIES) break;

    text = await rewrite({ text, issues, persona, guardrails, language: intentAnalysis.language });
    retries++;
  }

  return { passed: false, text: '', rewrite_applied: true };
}

function validate(text, guardrails) {
  const issues = [];
  const words = text.trim().split(/\s+/);

  if (words.length > 80) issues.push(`Too long: ${words.length} words (max 80)`);
  if ((text.match(/\?/g) ?? []).length > 1) issues.push('More than one question');
  if (words.length > 10 && !/([\?!]|book|call|schedule|contact|שלח|אשמח)/i.test(text)) issues.push('No forward motion signal');

  const forbidden = guardrails?.forbidden_phrases ?? [];
  for (const phrase of forbidden) {
    if (text.toLowerCase().includes(phrase.toLowerCase())) issues.push(`Forbidden phrase: "${phrase}"`);
  }
  for (const phrase of GENERIC_AI_PHRASES) {
    if (text.toLowerCase().includes(phrase)) issues.push(`Generic AI phrase: "${phrase}"`);
  }

  return issues;
}

async function rewrite({ text, issues, persona, guardrails, language }) {
  const prompt = `Rewrite this sales message to fix these issues: ${issues.join('; ')}.
Keep the same intent. Sound human. Max 80 words. One question max.
Persona tone: ${JSON.stringify(persona?.tone ?? 'warm')}.
Language: ${language}.
Forbidden phrases: ${JSON.stringify(guardrails?.forbidden_phrases ?? [])}.

Original: "${text}"
Rewritten:`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text.trim();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapCtaDecision(cta_decision) {
  const map = {
    cta:      { next_stage: 'cta',           action: 'commit', cta_triggered: true  },
    qualify:  { next_stage: 'qualification', action: 'none',   cta_triggered: false },
    clarify:  { next_stage: 'clarification', action: 'none',   cta_triggered: false },
    escalate: { next_stage: 'escalated',     action: 'none',   cta_triggered: false },
  };
  return map[cta_decision] ?? map.clarify;
}

function ok(result) { return { status: 'success', result, error: null }; }
