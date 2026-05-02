// WA_08 replacement — demo learning phase, persona extraction

import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../lib/supabase.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';

const SIMULATION_SCENARIOS = [
  'מה אתם מציעים?',
  'כמה זה עולה?',
  'למה דווקא אתם?',
  'אני לא בטוח עכשיו, אחזור אליך',
  'אפשר לדבר עם מישהו?',
];

export async function runLearning({ message, session_id, context }) {
  const { business_id } = context;

  if (!session_id || !business_id) {
    return { status: 'error', result: null, error: 'Missing session_id or business_id' };
  }

  const learning_stage    = context.current_stage ?? 'intro';
  const simulation_history = context.simulation_history ?? [];
  const persona            = context.persona ?? {};

  try {
    const { response, extracted_patterns, next_stage, updated_history, persona_updated } =
      await runStage({ learning_stage, message, simulation_history, persona });

    // Persist extracted patterns if extraction just happened
    if (persona_updated && extracted_patterns) {
      await supabase.from('business_profiles')
        .update({
          persona:          { ...persona, ...extracted_patterns },
          hebrew_patterns:  extracted_patterns.hebrew_patterns ?? {},
          updated_at:       new Date().toISOString(),
        })
        .eq('business_id', business_id);
    }

    // Advance learning stage in sessions
    await supabase.from('sessions')
      .update({
        current_stage:      next_stage,
        simulation_history: updated_history,
        updated_at:         new Date().toISOString(),
      })
      .eq('session_id', session_id);

    return {
      status: 'success',
      result: {
        response,
        extracted_patterns: extracted_patterns ?? null,
        persona_updated,
        learning_stage: next_stage,
        updated_simulation_history: updated_history,
      },
      error: null,
    };
  } catch (e) {
    return { status: 'error', result: null, error: e.message };
  }
}

// ── Stage dispatcher ──────────────────────────────────────────────────────────

async function runStage({ learning_stage, message, simulation_history, persona }) {
  switch (learning_stage) {
    case 'intro':       return runIntro(message, simulation_history);
    case 'simulation':  return runSimulation(message, simulation_history, persona);
    case 'extraction':  return runExtraction(message, simulation_history);
    case 'complete':    return runComplete(message);
    default:            return runIntro(message, simulation_history);
  }
}

// ── Intro ─────────────────────────────────────────────────────────────────────

async function runIntro(message, history) {
  const text = await callClaude(
    `אתה עוזר להגדיר סוכן מכירות לעסק. תאר בחום את תרגיל הסימולציה: תשלח 5 הודעות של לקוחות פוטנציאליים ותבקש מבעל העסק להגיב בדיוק כמו שהוא היה עונה בפועל. שאל אם הוא מוכן להתחיל.`,
    `הודעת הבעלים: "${message}"`
  );

  const updated_history = [...history, { role: 'coordinator', content: text }];
  return { response: text, next_stage: 'simulation', updated_history, persona_updated: false };
}

// ── Simulation ────────────────────────────────────────────────────────────────

async function runSimulation(message, history, persona) {
  // Log owner's reply
  const updated_history = [...history, { role: 'owner', content: message }];

  // Determine which scenario to send next
  const sent_count = updated_history.filter(m => m.role === 'lead').length;
  const is_done    = sent_count >= SIMULATION_SCENARIOS.length;

  if (is_done) {
    // All scenarios done — move to extraction
    const bridge = await callClaude(
      `אמור לבעל העסק שסיימתם את הסימולציות בצורה מעולה ועכשיו תנתח את סגנון התקשורת שלו כדי להכשיר את הסוכן.`,
      `היסטוריה: ${JSON.stringify(updated_history.slice(-4))}`
    );
    updated_history.push({ role: 'coordinator', content: bridge });
    return { response: bridge, next_stage: 'extraction', updated_history, persona_updated: false };
  }

  // Send next lead scenario
  const scenario = SIMULATION_SCENARIOS[sent_count];
  const lead_text = await callClaude(
    `אתה לקוח פוטנציאלי שכותב הודעת WhatsApp לעסק. שלח הודעה קצרה וטבעית בסגנון: "${scenario}". רק את ההודעה עצמה, ללא הסברים.`,
    `הקשר עסקי: ${JSON.stringify(persona)}`
  );

  updated_history.push({ role: 'lead', content: lead_text });

  return {
    response: lead_text,
    next_stage: 'simulation',
    updated_history,
    persona_updated: false,
  };
}

// ── Extraction ────────────────────────────────────────────────────────────────

async function runExtraction(message, history) {
  const all_history = [...history, { role: 'owner', content: message }];

  const prompt = `אתה מומחה לניתוח דפוסי תקשורת.
נתח את השיחות שבהן בעל העסק ענה לסימולציות לקוחות.
חלץ את סגנון הכתיבה וחזור עם JSON בלבד:
{
  "tone": "formal|casual|warm",
  "wording_style": "תיאור קצר",
  "sentence_patterns": ["דוגמה 1", "דוגמה 2"],
  "hebrew_patterns": {
    "greetings": [],
    "closings": [],
    "objection_phrases": [],
    "cta_phrases": []
  },
  "emoji_usage": "none|light|heavy",
  "key_phrases": []
}`;

  const raw = await callClaude(prompt, `שיחות סימולציה: ${JSON.stringify(all_history)}`);
  let extracted_patterns = null;

  try {
    const clean = raw.replace(/```json\n?|\n?```/g, '').trim();
    extracted_patterns = JSON.parse(clean);
  } catch {
    extracted_patterns = null;
  }

  const completion = await callClaude(
    `אמור לבעל העסק שהסוכן אומן בהצלחה על סגנון הדיבור שלו ועכשיו מוכן להתחיל לעבוד.`,
    `דפוסים שחולצו: ${JSON.stringify(extracted_patterns)}`
  );

  all_history.push({ role: 'coordinator', content: completion });

  return {
    response: completion,
    next_stage: 'complete',
    updated_history: all_history,
    extracted_patterns,
    persona_updated: !!extracted_patterns,
  };
}

// ── Complete ──────────────────────────────────────────────────────────────────

async function runComplete(message) {
  const text = await callClaude(
    `הסוכן כבר מאומן. שלח הודעת סיום קצרה שמאשרת שהסוכן פעיל.`,
    `הודעת הבעלים: "${message}"`
  );
  return { response: text, next_stage: 'complete', updated_history: [], persona_updated: false };
}

// ── Helper ────────────────────────────────────────────────────────────────────

async function callClaude(system, userContent, maxTokens = 600) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: userContent }],
  });
  return response.content[0].text.trim();
}
