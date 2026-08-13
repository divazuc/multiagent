// WA_02 replacement — load session + business profile + conversation history
//
// SESSIONS ARE PER (PHONE, BUSINESS) — pilot finding, 2026-08-12. One phone
// can hold live conversations with TWO tenants' bots at once (the pilot
// owner's phone talks to both the Divaz bot and her own kids-business bot).
// The receiving WhatsApp number resolves the business FIRST, and the session
// lookup is scoped to that business: a conversation with the kids bot gets its
// own kids-bound session row and never reads — let alone re-points — the
// Divaz-bound one, and vice versa.
//
// Until docs/sql/2026-08-13-sessions-per-business.sql is applied the sessions
// table is still unique on session_id alone, so a second business's row cannot
// be inserted. That exact failure falls back to TODAY'S behaviour — re-point
// the phone's single row at the business that owns the receiving number
// (lib/session-routing.js) — so nothing changes for any tenant until the
// migration lands. Single-business phones (the overwhelmingly common case)
// never hit either branch: their scoped lookup finds their one row every time.

import { supabase as realSupabase } from './supabase.js';
import { resolveSessionBusiness } from './session-routing.js';

let supabase = realSupabase; // test seam — loadContext is where the pilot's
export function _setSupabaseForTest(fake) { supabase = fake ?? realSupabase; } // cross-tenant re-point lived

const HISTORY_LIMIT = 50;
const QUALIFICATION_FIELDS = ['need', 'scope', 'budget', 'timeline', 'urgency'];
const SESSION_COLS = 'session_id, business_id, session_mode, current_stage, current_setup_stage, setup_completed, qualification_progress';

export async function loadContext({ message, session_id, phone_number_id = null }) {
  try {
    // The business that owns the receiving number — resolved BEFORE the
    // session lookup, because it is the scope of that lookup. Null for the
    // Studio console and scripted tests (no phone_number_id), which keep the
    // session_id-only lookup: synthetic ids, one row, no ambiguity.
    let numberBusinessId = null;
    if (phone_number_id) {
      const { data: biz } = await supabase
        .from('businesses')
        .select('id')
        .eq('wa_phone_number_id', phone_number_id)
        .maybeSingle();
      numberBusinessId = biz?.id ?? null;
    }

    let query = supabase.from('sessions').select(SESSION_COLS).eq('session_id', session_id);
    if (numberBusinessId) query = query.eq('business_id', numberBusinessId);
    const { data: sessionRows, error: sessionErr } = await query
      .order('updated_at', { ascending: false })
      .limit(1);
    if (sessionErr) return err(`Session lookup failed: ${sessionErr.message}`);
    let session = sessionRows?.[0] ?? null;

    // No session for this (phone, business) pair. If the number resolved a
    // business, create one bound to it, then fall through so the FIRST reply
    // already has the full business profile + knowledge loaded.
    if (!session && numberBusinessId) {
      const fresh = {
        session_id, business_id: numberBusinessId,
        session_mode: 'live', current_stage: 'greeting', setup_completed: true,
      };
      const { error: insErr } = await supabase.from('sessions').insert(fresh);
      if (!insErr) {
        session = {
          ...fresh,
          current_setup_stage: null,
          qualification_progress: {},
        };
      } else {
        // The insert was refused. Either a concurrent request created the same
        // pair a moment ago, or this is the PRE-MIGRATION schema (unique on
        // session_id alone) and the phone's one row belongs to another
        // business. Re-read to tell the two apart.
        const { data: existingRows, error: reErr } = await supabase
          .from('sessions').select(SESSION_COLS).eq('session_id', session_id)
          .order('updated_at', { ascending: false })
          .limit(2);
        if (reErr) return err(`Session lookup failed: ${reErr.message}`);
        session = (existingRows ?? []).find(s => s.business_id === numberBusinessId) ?? null;

        if (!session) {
          const stale = existingRows?.[0] ?? null;
          if (!stale) return err(`Session create failed: ${insErr.message}`);
          // Pre-migration fallback — exactly today's behaviour: the receiving
          // number is the authority, the single row is re-pointed at it
          // (lib/session-routing.js is the rule; the live bug it fixed was a
          // session stuck on a business its number had left).
          const { corrected } = resolveSessionBusiness({
            sessionBusinessId: stale.business_id,
            businessIdFromNumber: numberBusinessId,
          });
          if (corrected) {
            console.warn(`[context] session ${session_id} was bound to ${stale.business_id}; ` +
              `the receiving number belongs to ${numberBusinessId} — re-pointing (pre-migration schema)`);
            await supabase.from('sessions')
              .update({ business_id: numberBusinessId, updated_at: new Date().toISOString() })
              .eq('session_id', session_id);
          }
          session = { ...stale, business_id: numberBusinessId };
        }
      }
    }

    if (!session) return err(`No business found for phone_number_id: ${phone_number_id}`);

    // Existing setup session — load draft; existing live session — load profile + history
    const isSetup = (session.session_mode === 'setup');

    const [profileRes, historyRes, draftRes, knowledgeItemsRes] = await Promise.all([
      isSetup ? Promise.resolve({ data: null, error: null }) :
        supabase.from('business_profiles')
          .select('business_id, business_name, business_model, sales_goal, conversation_strategy, services, decision_logic, key_questions, objection_handling, persona, guardrails, hebrew_patterns, agent_mode, cta_goal, knowledge')
          .eq('business_id', session.business_id)
          .maybeSingle(),
      isSetup ? Promise.resolve({ data: [], error: null }) :
        loadHistory(session_id, session.business_id),
      isSetup ?
        supabase.from('setup_drafts').select('draft_setup_data, current_setup_stage').eq('session_id', session_id).maybeSingle() :
        Promise.resolve({ data: null, error: null }),
      // Structured FAQ rows for lib/kb-retrieval.js / lib/kb-direct-match.js
      // (cost-efficiency pass, 2026-08-12) — the retrieval engine works off
      // question/answer/category rows, not the pre-formatted faq_summary
      // text blob. Soft-fails to [] (never blocks the whole context load):
      // a missing table/RLS issue just falls back to conversation.js's
      // existing faq_summary path, exactly the "retrieval error → fallback"
      // behavior item 3 asks for.
      isSetup ? Promise.resolve({ data: [], error: null }) :
        supabase.from('knowledge_items')
          .select('question, answer, category, archetypes')
          .eq('business_id', session.business_id)
          .eq('is_active', true),
    ]);

    if (profileRes.error) return err(`Profile load failed: ${profileRes.error.message}`);
    if (historyRes.error) return err(`History load failed: ${historyRes.error.message}`);

    const profile = profileRes.data ?? {};
    const draft = draftRes.data;
    const knowledgeItems = knowledgeItemsRes?.error ? [] : (knowledgeItemsRes?.data ?? []);
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
        agent_mode: profile.agent_mode ?? undefined,
        cta_goal: normalizeCtaGoal(profile.cta_goal),
        // `items` (structured rows) feeds retrieval/direct-match;
        // `faq_summary` stays as the fail-soft fallback text — see the
        // knowledgeItemsRes comment above.
        knowledge: { ...parseJson(profile.knowledge, {}), items: knowledgeItems },
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

// History is scoped to the session's business: on a phone that talks to two
// tenants' bots, one tenant's conversation must never ride into the other's
// model context. The `conversations` view only exposes business_id after the
// 2026-08-13 migration — on the pre-migration view the scoped select errors,
// and the unscoped read is exactly today's behaviour (one business per phone
// pre-migration, so nothing to mix).
async function loadHistory(session_id, business_id) {
  const base = () => supabase.from('conversations')
    .select('role, content, stage, created_at')
    .eq('session_id', session_id)
    .order('created_at', { ascending: true })
    .limit(HISTORY_LIMIT);
  if (business_id) {
    const scoped = await base().eq('business_id', business_id);
    if (!scoped.error) return scoped;
  }
  return base();
}

// cta_goal is stored as a stringified array (e.g. '["book_call"]')
function normalizeCtaGoal(value) {
  const parsed = parseJson(value, value);
  if (Array.isArray(parsed)) return parsed.join(', ') || undefined;
  return parsed ?? undefined;
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function ok(result) { return { status: 'success', result, error: null }; }
function err(msg)   { return { status: 'error', result: null, error: msg }; }
