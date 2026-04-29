// WA_06 + WA_07 replacement — all DB writes post-pipeline

import { supabase } from './supabase.js';

// ── WA_06: Save a single conversation turn ────────────────────────────────────
export async function saveConversation({ session_id, business_id, user_message, agent_response, stage, action, qualification_progress, cta_triggered, escalate, escalation_reason, language }) {
  const required = { session_id, business_id, user_message, agent_response, stage };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return err(`Missing required fields: ${missing.join(', ')}`);

  const [msgRes, sessionRes] = await Promise.all([
    supabase.from('conversation_messages').insert({
      session_id, business_id, user_message, agent_response, stage,
      action: action ?? 'none',
      qualification_progress: qualification_progress ?? {},
      cta_triggered: cta_triggered ?? false,
      escalate: escalate ?? false,
      escalation_reason: escalation_reason ?? null,
      language: language ?? 'hebrew',
    }),
    supabase.from('sessions')
      .update({
        current_stage: stage,
        last_message_at: new Date().toISOString(),
        cta_triggered: cta_triggered ?? false,
        escalate: escalate ?? false,
        qualification_progress: qualification_progress ?? {},
      })
      .eq('session_id', session_id)
      .eq('session_mode', 'live'),
  ]);

  if (msgRes.error) return err(`Message insert failed: ${msgRes.error.message}`);
  return ok({ saved: true, session_id });
}

// ── WA_07: Save setup state (draft or commit) ─────────────────────────────────
export async function saveSetupState({ session_id, business_id, action, current_setup_stage, next_setup_stage, draft_setup_data, setup_completed }) {
  if (action === 'none') return ok({ saved: false, business_id, setup_completed: false });

  if (action === 'save_draft') {
    const { error: draftErr } = await supabase.from('setup_drafts').upsert({
      session_id,
      business_id,
      current_setup_stage: next_setup_stage ?? current_setup_stage,
      draft_setup_data: draft_setup_data ?? {},
      updated_at: new Date().toISOString(),
    }, { onConflict: 'session_id' });

    if (draftErr) return err(`Draft save failed: ${draftErr.message}`);

    const { error: sessionErr } = await supabase.from('sessions')
      .upsert({ session_id, current_setup_stage: next_setup_stage ?? current_setup_stage, setup_completed: false, session_mode: 'setup' }, { onConflict: 'session_id' });

    if (sessionErr) return err(`Session update failed: ${sessionErr.message}`);
    return ok({ saved: true, business_id, setup_completed: false });
  }

  if (action === 'commit') {
    const d = draft_setup_data ?? {};
    const { error: profileErr } = await supabase.from('business_profiles').upsert({
      business_id,
      session_id,
      business_model:        d.collect_business_model?.business_model ?? d.archetype ?? null,
      sales_goal:            d.collect_sales_goal?.sales_goal ?? null,
      conversation_strategy: d.collect_sales_goal?.conversation_strategy ?? null,
      services:              d.service_collect_offerings?.services ?? d.studio_collect_classes?.classes ?? d.generic_collect_services?.services ?? [],
      persona:               d.collect_persona ?? {},
      guardrails:            d.collect_guardrails ?? {},
      hebrew_patterns:       d.collect_persona?.hebrew_patterns ?? {},
      setup_completed:       true,
      committed_at:          new Date().toISOString(),
      updated_at:            new Date().toISOString(),
    }, { onConflict: 'business_id' });

    if (profileErr) return err(`Profile commit failed: ${profileErr.message}`);

    const { error: sessionErr } = await supabase.from('sessions')
      .update({ setup_completed: true, current_setup_stage: 'complete' })
      .eq('session_id', session_id);

    if (sessionErr) return err(`Session update failed: ${sessionErr.message}`);
    return ok({ saved: true, business_id, setup_completed: true });
  }

  return err(`Unknown action: ${action}`);
}

function ok(result) { return { status: 'success', result, error: null }; }
function err(msg)   { return { status: 'error', result: null, error: msg }; }
