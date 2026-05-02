'use strict'

const PREFIX = 'wfg_draft_'
const INDEX_KEY = 'wfg_drafts'

function getIndex() {
  try { return JSON.parse(localStorage.getItem(INDEX_KEY) || '[]') } catch { return [] }
}

export function saveDraft(slug, data) {
  if (!slug) return
  try {
    const draft = { ...data, slug, savedAt: new Date().toISOString() }
    localStorage.setItem(PREFIX + slug, JSON.stringify(draft))
    const index = getIndex()
    if (!index.includes(slug)) {
      localStorage.setItem(INDEX_KEY, JSON.stringify([...index, slug]))
    }
  } catch {
    // QuotaExceededError — silently skip
  }
}

export function loadDraft(slug) {
  try { return JSON.parse(localStorage.getItem(PREFIX + slug)) } catch { return null }
}

export function listDrafts() {
  return getIndex()
    .map(slug => { try { return JSON.parse(localStorage.getItem(PREFIX + slug)) } catch { return null } })
    .filter(Boolean)
    .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))
}

export function deleteDraft(slug) {
  if (!slug) return
  localStorage.removeItem(PREFIX + slug)
  localStorage.setItem(INDEX_KEY, JSON.stringify(getIndex().filter(s => s !== slug)))
}
