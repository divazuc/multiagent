// Admin-key auth for the operator surfaces (Studio + /demo).
// The agent server requires `Authorization: Bearer <ADMIN_API_KEY>` on every
// operator endpoint once STUDIO_AUTH_REQUIRED is on (server/lib/auth.js).
// Rather than threading the header through every fetch call site, we patch
// window.fetch once per page: any request aimed at the agent server gets the
// stored key attached — unless the caller already set Authorization (the
// portal client signs its own requests) or the path is /portal/* (client
// tokens, never the admin key).

const STORAGE_KEY = 'wa_admin_key'
const AGENT_BASE = import.meta.env.VITE_AGENT_URL ?? ''
const DEV_BASE = '/api/agent'

export function getAdminKey() {
  try { return localStorage.getItem(STORAGE_KEY) || '' } catch { return '' }
}

export function setAdminKey(key) {
  localStorage.setItem(STORAGE_KEY, key)
}

export function clearAdminKey() {
  localStorage.removeItem(STORAGE_KEY)
}

function isAgentUrl(url) {
  if (AGENT_BASE && url.startsWith(AGENT_BASE)) return true
  return url.startsWith(DEV_BASE)
}

function isPortalPath(url) {
  return url.includes('/portal/')
}

export async function verifyAdminKey(key) {
  const base = AGENT_BASE || DEV_BASE
  try {
    const res = await fetch(`${base}/auth/check`, {
      headers: { Authorization: `Bearer ${key}` },
    })
    return res.ok
  } catch {
    return false
  }
}

let installed = false

export function installAdminFetch(onUnauthorized) {
  if (installed) return
  installed = true
  const orig = window.fetch.bind(window)
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : input?.url ?? ''
    if (!isAgentUrl(url) || isPortalPath(url)) return orig(input, init)

    const headers = new Headers(
      init.headers ?? (typeof input === 'object' && input?.headers) ?? undefined,
    )
    if (!headers.has('Authorization')) {
      const key = getAdminKey()
      if (key) headers.set('Authorization', `Bearer ${key}`)
    }
    const res = await orig(input, { ...init, headers })
    if (res.status === 401) onUnauthorized?.()
    return res
  }
}
