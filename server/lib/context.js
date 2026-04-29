// WA_02 replacement — load session + business profile + conversation history

import { supabase } from './supabase.js';

const HISTORY_LIMIT = 50;
const QUALIFICATION_FIELDS = ['need', 'scope', 'budget', 'timeline', 'urgency'];

export async function loadContext({ message, session_id }) {
  try {
    const { data: session, error: sessionErr } = await supabase
      .from('sessions')
      .select('session_id, business_id, session_mode, current_stage, current_setup_stage, setup_completed, qualification_progress')
      .eq('session_id', session_id)
      .maybeSingle();

    if (sessionErr) return err(`Session lookup failed: ${sessionErr.message}`);

    // New session — upsert a session row and return minimal context
    if (!session?.business_id) {
      await supabase.from('sessions').upsert(
        { session_id, session_mode: 'setup', current_stage: 'collect_business_model', setup_completed: false },
        { onConflict: 'session_id', ignoreDuplicates: true }
      );
      return ok({
        business_id: null,
        session_mode: 'setup',
        setup_completed: false,
        current_stage: 'collect_business_model',
        draft_setup_data: {},
        business_profile: {},
        persona: {},
        guardrails: {},
        hebrew_patterns: {},
        conversation_history: [],
        missing_qualification_data: [...QUALIFICATION_FIELDS],
        qualification_progress: {},
      });
    }

    // Existing setup session — load draft; existing live session — load profile + history
    const isSetup = (session.session_mode === 'setup');

    const [profileRes, historyRes, draftRes] = await Promise.all([
      isSetup ? Promise.resolve({ data: null, error: null }) :
        supabase.from('business_profiles')
          .select('business_id, business_name, business_model, sales_goal, conversation_strategy, services, decision_logic, key_questions, objection_handling, persona, guardrails, hebrew_patterns')
          .eq('business_id', session.business_id)
          .maybeSingle(),
      isSetup ? Promise.resolve({ data: [], error: null }) :
        supabase.from('conversations')
          .select('role, content, stage, created_at')
          .eq('session_id', session_id)
          .order('created_at', { ascending: true })
          .limit(HISTORY_LIMIT),
      isSetup ?
        supabase.from('setup_drafts').select('draft_setup_data, current_setup_stage').eq('session_id', session_id).maybeSingle() :
        Promise.resolve({ data: null, error: null }),
    ]);

    if (profileRes.error) return err(`Profile load failed: ${profileRes.error.message}`);
    if (historyRes.error) return err(`History load failed: ${historyRes.error.message}`);

    const profile = profileRes.data ?? {};
    const draft = draftRes.data;
    const qualification_progress = session.qualification_progress ?? {};
    const missing_qualification_data = QUALIFICATION_FIELDS.filter(f => !qualification_progress[f]);

    return ok({
      business_id: session.business_id,
      session_mode: session.session_mode ?? 'live',
      setup_completed: session.setup_completed ?? false,
      current_stage: draft?.current_setup_stage ?? session.current_setup_stage ?? session.current_stage ?? 'collect_business_model',
      draft_setup_data: draft?.draft_setup_data ?? {},
      business_profile: {
        business_name: profile.business_name,
        business_model: profile.business_model,
        sales_goal: profile.sales_goal,
        conversation_strategy: profile.conversation_strategy,
        services: parseJson(profile.services, []),
        decision_logic: profile.decision_logic,
        key_questions: profile.key_questions,
        objection_handling: profile.objection_handling,
      },
      persona: parseJson(profile.persona, {}),
      guardrails: parseJson(profile.guardrails, {}),
      hebrew_patterns: parseJson(profile.hebrew_patterns, {}),
      conversation_history: historyRes.data ?? [],
      missing_qualification_data,
      qualification_progress,
    });
  } catch (e) {
    return err(`Unexpected error: ${e.message}`);
  }
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function ok(result) { return { status: 'success', result, error: null }; }
function err(msg)   { return { status: 'error', result: null, error: msg }; }
