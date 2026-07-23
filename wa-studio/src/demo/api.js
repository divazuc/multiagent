// Two API clients with an identical surface, so the dashboard components are
// mode-agnostic: the demo client hits the open studio endpoints with a biz id
// from the URL; the portal client hits /portal/* where the business is
// resolved server-side from the signed token.

const AGENT = import.meta.env.VITE_AGENT_URL || '/api/agent'

async function jsonOrThrow(res) {
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`)
  return body
}

export function createDemoApi(bizId) {
  async function rpc(fn, ...args) {
    const res = await fetch(`${AGENT}/studio/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fn, args }),
    })
    return (await jsonOrThrow(res)).result
  }

  return {
    bizId,
    async getBusinessName() {
      const list = await rpc('listBusinesses')
      return list.find(b => b.id === bizId)?.name ?? null
    },
    getOverviewStats: (days) => rpc('getOverviewStats', bizId, days),
    loadFaqItems: () => rpc('loadFaqItems', bizId),
    updateFaqItem: (id, updates) => rpc('updateFaqItem', id, updates),
    addFaqItem: (fields) => rpc('addFaqItem', bizId, fields),
    getBotSettings: () => rpc('getBotSettings', bizId),
    async updateBotSettings(updates) {
      await jsonOrThrow(await fetch(`${AGENT}/business/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: bizId, updates }),
      }))
    },
    async listContacts() {
      const body = await jsonOrThrow(await fetch(`${AGENT}/contacts/${bizId}`))
      return body.contacts ?? []
    },
    async getBilling() {
      try { return await (await fetch(`${AGENT}/billing/${bizId}`)).json() } catch { return null }
    },
    async updateContact(id, updates) {
      await jsonOrThrow(await fetch(`${AGENT}/contacts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      }))
    },
    async loadThread(phone) {
      const state = await rpc('loadDBState', phone)
      return { messages: state?.messages ?? [], session: state?.session ?? null }
    },
  }
}

export function createPortalApi(token, business, onAuthExpired) {
  async function rpc(fn, ...args) {
    const res = await fetch(`${AGENT}/portal/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fn, args }),
    })
    if (res.status === 401) { onAuthExpired?.(); throw new Error('unauthorized') }
    return (await jsonOrThrow(res)).result
  }

  return {
    bizId: business.id,
    getBusinessName: async () => business.name,
    getOverviewStats: (days) => rpc('getOverviewStats', days),
    loadFaqItems: () => rpc('loadFaqItems'),
    updateFaqItem: (id, updates) => rpc('updateFaqItem', id, updates),
    addFaqItem: (fields) => rpc('addFaqItem', fields),
    getBotSettings: () => rpc('getBotSettings'),
    updateBotSettings: (updates) => rpc('updateBotSettings', updates),
    listContacts: () => rpc('listContacts'),
    getBilling: async () => null, // no billing pipeline for real clients yet
    updateContact: (id, updates) => rpc('updateContact', id, updates),
    loadThread: (phone) => rpc('loadThread', phone),
  }
}

export async function portalLogin(email, password) {
  const res = await fetch(`${AGENT}/portal/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return jsonOrThrow(res) // { ok, token, business }
}
