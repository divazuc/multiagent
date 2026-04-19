import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))

// Load .env from wa-studio root
function loadEnv() {
  const envPath = resolve(__dir, '../.env')
  const lines = readFileSync(envPath, 'utf-8').split('\n')
  const env = {}
  for (const line of lines) {
    const m = line.match(/^([^#=]+)=(.*)$/)
    if (m) env[m[1].trim()] = m[2].trim()
  }
  return env
}

const env = loadEnv()

export const SUPABASE_URL = env.VITE_SUPABASE_URL
export const SUPABASE_KEY = env.VITE_SUPABASE_ANON_KEY
export const N8N_URL      = (env.VITE_N8N_URL || '').replace(/\/$/, '')
export const WEBHOOK_URL  = `${N8N_URL}/webhook/wa-inbound`

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ── Session helpers ───────────────────────────────────────────────────────────

export async function createTestSession(mode = 'setup', businessId = null) {
  const sessionId = `test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
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
    .select().single()
  if (error) throw new Error('createTestSession: ' + error.message)
  return data
}

export async function createTestBusiness(name = 'Test Business') {
  const slug = name.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now()
  const { data, error } = await supabase
    .from('businesses')
    .insert({ name, slug, plan_type: 'basic', status: 'active', is_test: true })
    .select().single()
  if (error) throw new Error('createTestBusiness: ' + error.message)
  return data
}

export async function seedKnowledgeItems(businessId, items) {
  const rows = items.map(q => ({
    business_id: businessId,
    category: q.category || 'general',
    question: q.question,
    answer: q.answer || '',
    language: 'he',
    is_active: !!q.answer,
  }))
  const { error } = await supabase.from('knowledge_items').insert(rows)
  if (error) throw new Error('seedKnowledgeItems: ' + error.message)
}

export async function seedBusinessProfile(businessId, sessionId) {
  await supabase.from('business_profiles').upsert({
    business_id: businessId,
    session_id: sessionId,
    business_model: '"service"',
    sales_goal: 'ייצור לידים',
    conversation_strategy: '',
    services: '[]',
    persona: '{"name":"עוזר","tone":"friendly"}',
    hebrew_patterns: '{}',
    guardrails: '{}',
    setup_completed: true,
    setup_stage: 'completed',
    draft_setup_data: '{}',
  }, { onConflict: 'business_id' })
}

export async function cleanup(sessionIds = [], businessIds = []) {
  for (const sid of sessionIds) {
    await supabase.from('conversation_messages').delete().eq('session_id', sid)
    await supabase.from('setup_drafts').delete().eq('session_id', sid)
    await supabase.from('sessions').delete().eq('session_id', sid)
  }
  for (const bid of businessIds) {
    await supabase.from('knowledge_items').delete().eq('business_id', bid)
    await supabase.from('business_profiles').delete().eq('business_id', bid)
    await supabase.from('businesses').delete().eq('id', bid)
  }
}

// ── Webhook helper ────────────────────────────────────────────────────────────

export async function send(sessionId, message, businessId = null, timeoutMs = 30000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, session_id: sessionId, business_id: businessId }),
      signal: controller.signal,
    })
    const body = await res.json().catch(() => ({}))
    return { status: res.status, ok: res.ok, body }
  } finally {
    clearTimeout(timer)
  }
}

// ── Assertion helpers ─────────────────────────────────────────────────────────

export function assert(condition, message) {
  if (!condition) throw new Error('ASSERT: ' + message)
}

export function assertBody(body, checks) {
  for (const [path, expected] of Object.entries(checks)) {
    const parts = path.split('.')
    let val = body
    for (const p of parts) val = val?.[p]
    if (expected instanceof RegExp) {
      assert(expected.test(String(val ?? '')), `${path} expected to match ${expected}, got: ${JSON.stringify(val)}`)
    } else {
      assert(val === expected, `${path} expected ${JSON.stringify(expected)}, got: ${JSON.stringify(val)}`)
    }
  }
}
