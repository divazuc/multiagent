import { ARCHETYPE_KEYS, filterStartersForArchetype } from './faq-starters.js'

const BASE = import.meta.env.VITE_AGENT_URL ?? ''
const api = path => BASE ? BASE + path : '/api/agent' + path

export async function apiFetch(path, opts = {}) {
  const res = await fetch(api(path), {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

// ── Businesses ──────────────────────────────────────────────────────────────

export async function listBusinesses() {
  return apiFetch('/data/businesses')
}

export async function createBusiness({ name, slug, archetype, planType = 'basic', phone, isTest = false }) {
  return apiFetch('/data/businesses', {
    method: 'POST',
    body: JSON.stringify({ name, slug, archetype, planType, phone, isTest }),
  })
}

export async function updateBusinessPhone(businessId, phone) {
  await apiFetch(`/data/businesses/${businessId}`, {
    method: 'PATCH',
    body: JSON.stringify({ whatsapp_number: phone }),
  })
}

export async function setBusinessStatus(businessId, status) {
  await apiFetch(`/data/businesses/${businessId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  })
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export async function createSession(sessionId, mode, businessId = null) {
  return apiFetch('/data/sessions', {
    method: 'POST',
    body: JSON.stringify({ sessionId, mode, businessId }),
  })
}

export async function listSessions() {
  return apiFetch('/data/sessions')
}

export async function loadDBState(sessionId) {
  return apiFetch(`/data/sessions/${encodeURIComponent(sessionId)}/state`)
}

export async function clearSessionData(sessionId) {
  await apiFetch(`/data/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
}

export async function advanceSetupStage(sessionId, nextStage, setupCompleted = false) {
  const body = { current_stage: nextStage, current_setup_stage: nextStage }
  if (setupCompleted) body.setup_completed = true
  await apiFetch(`/data/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function markSetupComplete(sessionId) {
  await apiFetch(`/data/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ setup_completed: true }),
  })
}

export async function setSessionMode(sessionId, mode) {
  await apiFetch(`/data/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ session_mode: mode }),
  })
}

// ── Knowledge (FAQ) ──────────────────────────────────────────────────────────

export async function loadFaqItems(businessId) {
  return apiFetch(`/data/knowledge/${businessId}`)
}

export async function loadSuggestedFaqCount(businessId) {
  const { count } = await apiFetch(`/data/knowledge/${businessId}/suggested-count`)
  return count ?? 0
}

export async function approveSuggestedFaqItem(id) {
  await apiFetch(`/data/knowledge/${id}/approve`, { method: 'PATCH' })
}

export async function dismissSuggestedFaqItem(id) {
  await apiFetch(`/data/knowledge/${id}`, { method: 'DELETE' })
}

export async function updateFaqItem(id, updates) {
  const clean = { ...updates }
  if ('archetypes' in clean) {
    clean.archetypes = Array.isArray(clean.archetypes)
      ? clean.archetypes.filter(a => ARCHETYPE_KEYS.includes(a))
      : []
  }
  await apiFetch(`/data/knowledge/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(clean),
  })
}

export async function deleteFaqItem(id) {
  await apiFetch(`/data/knowledge/${id}`, { method: 'DELETE' })
}

export async function addFaqItem(businessId, { category, question, answer = '', archetypes = [] }) {
  const safeArchetypes = Array.isArray(archetypes)
    ? archetypes.filter(a => ARCHETYPE_KEYS.includes(a))
    : []
  return apiFetch(`/data/knowledge/${businessId}`, {
    method: 'POST',
    body: JSON.stringify({ category, question, answer, archetypes: safeArchetypes }),
  })
}

export async function seedFaqStarters(businessId, archetype) {
  const starters = filterStartersForArchetype(archetype)
  await apiFetch(`/data/knowledge/${businessId}/seed`, {
    method: 'POST',
    body: JSON.stringify({ starters }),
  })
}

export async function seedBusinessProfile(sessionId, profile) {
  await apiFetch(`/data/sessions/${encodeURIComponent(sessionId)}/seed-profile`, {
    method: 'POST',
    body: JSON.stringify(profile),
  })
}
