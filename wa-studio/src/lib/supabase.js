import { ARCHETYPE_KEYS, filterStartersForArchetype } from './faq-starters.js'

// All DB access goes through the agent server's /studio/rpc whitelist —
// the anon key no longer has table grants (RLS audit 2026-05). Function
// signatures are unchanged from the old direct-supabase implementation.

const AGENT_BASE = import.meta.env.VITE_AGENT_URL ?? ''
const RPC_URL = AGENT_BASE ? `${AGENT_BASE}/studio/rpc` : '/api/agent/studio/rpc'

async function rpc(fn, ...args) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fn, args }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.ok === false) {
    throw new Error(body.error || `${fn}: HTTP ${res.status}`)
  }
  return body.result
}

// ── Businesses ──────────────────────────────────────────────────────────────

export async function listBusinesses() {
  return (await rpc('listBusinesses')) || []
}

// ── Modules ─────────────────────────────────────────────────────────────────

export async function getModules(businessId) {
  return (await rpc('getModules', businessId)) || []
}

export async function updateModule(businessId, moduleKey, payload) {
  await rpc('updateModule', businessId, moduleKey, payload)
}

export async function createConnectLink(businessId, moduleKey) {
  return rpc('createConnectLink', businessId, moduleKey)
}

export async function createBusiness({ name, slug, archetype, planType = 'basic', phone, isTest = false }) {
  return rpc('createBusiness', { name, slug, archetype, planType, phone, isTest })
}

export async function updateBusinessPhone(businessId, phone) {
  await rpc('updateBusinessPhone', businessId, phone)
}

export async function setBusinessStatus(businessId, status) {
  await rpc('setBusinessStatus', businessId, status)
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export async function createSession(sessionId, mode, businessId = null) {
  return rpc('createSession', sessionId, mode, businessId)
}

export async function listSessions() {
  return (await rpc('listSessions')) || []
}

// ── DB state for inspector ───────────────────────────────────────────────────

export async function loadDBState(sessionId) {
  const state = await rpc('loadDBState', sessionId)
  return state || { session: null, draft: null, profile: null, messages: [] }
}

export async function clearSessionData(sessionId) {
  await rpc('clearSessionData', sessionId)
}

export async function advanceSetupStage(sessionId, nextStage, setupCompleted = false) {
  await rpc('advanceSetupStage', sessionId, nextStage, setupCompleted)
}

export async function markSetupComplete(sessionId) {
  await rpc('markSetupComplete', sessionId)
}

export async function setSessionMode(sessionId, mode) {
  await rpc('setSessionMode', sessionId, mode)
}

// ── FAQ / knowledge items ────────────────────────────────────────────────────

export async function loadFaqItems(businessId) {
  return (await rpc('loadFaqItems', businessId)) || []
}

export async function loadSuggestedFaqCount(businessId) {
  try {
    return (await rpc('loadSuggestedFaqCount', businessId)) || 0
  } catch {
    return 0
  }
}

export async function approveSuggestedFaqItem(id) {
  await rpc('approveSuggestedFaqItem', id)
}

export async function dismissSuggestedFaqItem(id) {
  await rpc('dismissSuggestedFaqItem', id)
}

export async function updateFaqItem(id, updates) {
  const clean = { ...updates }
  if ('archetypes' in clean) {
    clean.archetypes = Array.isArray(clean.archetypes)
      ? clean.archetypes.filter(a => ARCHETYPE_KEYS.includes(a))
      : []
  }
  await rpc('updateFaqItem', id, clean)
}

export async function deleteFaqItem(id) {
  await rpc('deleteFaqItem', id)
}

export async function addFaqItem(businessId, { category, question, answer = '', archetypes = [] }) {
  const safeArchetypes = Array.isArray(archetypes)
    ? archetypes.filter(a => ARCHETYPE_KEYS.includes(a))
    : []
  return rpc('addFaqItem', businessId, { category, question, answer, archetypes: safeArchetypes })
}

export async function seedFaqStarters(businessId, archetype) {
  const starters = filterStartersForArchetype(archetype)
  if (!starters.length) return
  const rows = starters.map(item => ({
    category: item.category,
    question: item.question,
    archetypes: item.archetypes,
  }))
  await rpc('seedFaqItems', businessId, rows)
}

export async function seedBusinessProfile(sessionId, profile) {
  await rpc('seedBusinessProfile', sessionId, profile)
}

// ── Agent runs (RunsPanel) ───────────────────────────────────────────────────

export async function listRuns(sessionId = null) {
  return (await rpc('listRuns', sessionId)) || []
}

export async function getRunSteps(runId) {
  return (await rpc('getRunSteps', runId)) || []
}
