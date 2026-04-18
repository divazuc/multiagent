import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

// ── Businesses ──────────────────────────────────────────────────────────────

export async function listBusinesses() {
  const { data, error } = await supabase
    .from('businesses')
    .select('id, name, archetype, plan_type, status, is_test, whatsapp_number, setup_completed, setup_stage, created_at')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

export async function createBusiness({ name, slug, archetype, planType = 'basic', phone, isTest = false }) {
  const whatsappNumber = phone || (isTest ? `test_${Math.random().toString(36).slice(2, 10).toUpperCase()}` : null)
  const { data, error } = await supabase
    .from('businesses')
    .insert({
      name,
      slug: slug || null,
      archetype: archetype || null,
      plan_type: planType,
      whatsapp_number: whatsappNumber,
      status: 'active',
      is_test: isTest,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateBusinessPhone(businessId, phone) {
  const { error } = await supabase
    .from('businesses')
    .update({ whatsapp_number: phone, updated_at: new Date().toISOString() })
    .eq('id', businessId)
  if (error) throw error
}

export async function setBusinessStatus(businessId, status) {
  const { error } = await supabase
    .from('businesses')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', businessId)
  if (error) throw error
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export async function createSession(sessionId, mode, businessId = null) {
  const { data, error } = await supabase
    .from('sessions')
    .upsert({
      session_id: sessionId,
      session_mode: mode,
      business_id: businessId,
      setup_completed: mode !== 'setup',
      current_stage: mode === 'setup' ? 'setup_start' : 'start',
      current_setup_stage: mode === 'setup' ? 'collect_business_model' : null,
    }, { onConflict: 'session_id' })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function listSessions() {
  const { data, error } = await supabase
    .from('sessions')
    .select('session_id, session_mode, current_stage, current_setup_stage, setup_completed, business_id, created_at, updated_at')
    .order('created_at', { ascending: false })
    .limit(30)
  if (error) throw error
  return data || []
}

// ── DB state for inspector ───────────────────────────────────────────────────

export async function loadDBState(sessionId) {
  const [sessionRes, draftRes, profileRes, messagesRes] = await Promise.all([
    supabase.from('sessions').select('*').eq('session_id', sessionId).single(),
    supabase.from('setup_drafts').select('*').eq('session_id', sessionId).maybeSingle(),
    supabase.from('sessions').select('business_id').eq('session_id', sessionId).single()
      .then(async r => {
        if (!r.data?.business_id) return { data: null }
        return supabase.from('business_profiles').select('*').eq('business_id', r.data.business_id).single()
      }),
    supabase.from('conversation_messages')
      .select('*').eq('session_id', sessionId)
      .order('created_at', { ascending: true }).limit(50)
  ])
  return {
    session: sessionRes.data || null,
    draft: draftRes.data || null,
    profile: profileRes.data || null,
    messages: messagesRes.data || []
  }
}

export async function advanceSetupStage(sessionId, nextStage) {
  await supabase
    .from('sessions')
    .update({ current_stage: nextStage, current_setup_stage: nextStage, updated_at: new Date().toISOString() })
    .eq('session_id', sessionId)
}

export async function seedBusinessProfile(sessionId, profile) {
  const businessId = `seed-${sessionId}`
  await supabase.from('business_profiles').upsert({
    business_id: businessId,
    session_id: sessionId,
    ...profile,
    setup_completed: true,
    setup_stage: 'completed',
    draft_setup_data: {},
  }, { onConflict: 'business_id' })
  await supabase.from('sessions').update({
    business_id: businessId,
    session_mode: 'live',
    setup_completed: true,
    current_stage: 'start',
    updated_at: new Date().toISOString()
  }).eq('session_id', sessionId)
}
