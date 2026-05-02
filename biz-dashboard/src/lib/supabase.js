import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

const AGENT = import.meta.env.VITE_AGENT_URL ?? ''
const api = (path) => `${AGENT}${path}`

export async function fetchOverview(businessId, month) {
  const [contactsRes, billingRes] = await Promise.all([
    supabase.from('contacts')
      .select('status', { count: 'exact' })
      .eq('business_id', businessId),
    fetch(api(`/billing/${businessId}?month=${month}`)).then(r => r.json()),
  ])

  const contacts = contactsRes.data ?? []
  const billing  = billingRes

  const statusCount = (s) => contacts.filter(c => c.status === s).length

  return {
    total_leads:       contacts.length,
    in_conversation:   statusCount('in_conversation'),
    cta_triggered:     statusCount('cta_triggered'),
    converted:         statusCount('converted'),
    cold:              statusCount('cold'),
    billing,
  }
}

export async function fetchContacts(businessId, { status, limit = 40, offset = 0 } = {}) {
  const res = await fetch(
    api(`/contacts/${businessId}?limit=${limit}&offset=${offset}${status ? `&status=${status}` : ''}`)
  )
  const data = await res.json()
  return data.contacts ?? []
}

export async function patchContact(id, updates) {
  await fetch(api(`/contacts/${id}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  })
}

export async function fetchMessages(sessionId) {
  const { data } = await supabase
    .from('conversation_messages')
    .select('user_message, agent_response, created_at')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true })
    .limit(50)
  return data ?? []
}

export async function fetchConversationHistory(businessId) {
  const { data } = await supabase
    .from('conversation_messages')
    .select('session_id, user_message, agent_response, created_at')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(200)
  return data ?? []
}
