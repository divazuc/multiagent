import { useEffect, useState, useCallback } from 'react'
import { fetchContacts, fetchMessages, patchContact } from '../lib/supabase'

const STATUS_OPTIONS = [
  { value: 'new_lead',        label: '🆕 ליד חדש' },
  { value: 'in_conversation', label: '💬 בשיחה' },
  { value: 'cta_triggered',   label: '📅 CTA הופעל' },
  { value: 'followup_sent',   label: '🔁 פולואפ נשלח' },
  { value: 'converted',       label: '✅ הומר' },
  { value: 'cold',            label: '🥶 קר' },
  { value: 'not_relevant',    label: '❌ לא רלוונטי' },
]

const STATUS_LABELS = Object.fromEntries(STATUS_OPTIONS.map(s => [s.value, s.label]))

const FILTERS = [
  { value: '',               label: 'הכל' },
  { value: 'new_lead',       label: '🆕 חדש' },
  { value: 'in_conversation',label: '💬 בשיחה' },
  { value: 'cta_triggered',  label: '📅 CTA' },
  { value: 'converted',      label: '✅ הומר' },
  { value: 'cold',           label: '🥶 קר' },
]

function timeAgo(ts) {
  if (!ts) return '—'
  const diff = Date.now() - new Date(ts).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60)   return `לפני ${mins}d`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)    return `לפני ${hrs}ש׳`
  const days = Math.floor(hrs / 24)
  return `לפני ${days} ימים`
}

function formatTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
}

export default function CRM({ businessId }) {
  const [contacts, setContacts]   = useState([])
  const [loading, setLoading]     = useState(true)
  const [filter, setFilter]       = useState('')
  const [expanded, setExpanded]   = useState(null)
  const [messages, setMessages]   = useState([])
  const [editing, setEditing]     = useState({})
  const [saving, setSaving]       = useState(false)

  const load = useCallback(async () => {
    if (!businessId) return
    setLoading(true)
    const data = await fetchContacts(businessId, { status: filter || undefined })
    setContacts(data)
    setLoading(false)
  }, [businessId, filter])

  useEffect(() => { load() }, [load])

  async function toggleExpand(contact) {
    if (expanded === contact.id) { setExpanded(null); return }
    setExpanded(contact.id)
    setEditing({ name: contact.name || '', notes: contact.notes || '', status: contact.status })
    const msgs = await fetchMessages(contact.phone)
    setMessages(msgs)
  }

  async function handleSave(contactId) {
    setSaving(true)
    await patchContact(contactId, editing)
    setSaving(false)
    await load()
    setExpanded(null)
  }

  return (
    <div>
      <div className="page-title">לידים / CRM</div>

      <div className="filter-bar">
        {FILTERS.map(f => (
          <button
            key={f.value}
            className={`filter-chip ${filter === f.value ? 'active' : ''}`}
            onClick={() => setFilter(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div className="loading">טוען לידים...</div>
        ) : contacts.length === 0 ? (
          <div className="empty">אין לידים עדיין בקטגוריה זו</div>
        ) : (
          <table className="crm-table">
            <thead>
              <tr>
                <th>טלפון / שם</th>
                <th>סטטוס</th>
                <th>סיכום AI</th>
                <th>הערה</th>
                <th>פעילות</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map(c => (
                <>
                  <tr key={c.id} className="clickable" onClick={() => toggleExpand(c)}>
                    <td>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{c.name || c.phone}</div>
                      {c.name && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.phone}</div>}
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                        {c.message_count} הודעות
                      </div>
                    </td>
                    <td>
                      <span className={`status-badge status-${c.status}`}>
                        {STATUS_LABELS[c.status] || c.status}
                      </span>
                    </td>
                    <td style={{ maxWidth: 240 }}>
                      <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                        {c.ai_summary || <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>ממתין לסיכום...</span>}
                      </div>
                    </td>
                    <td style={{ maxWidth: 180 }}>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{c.notes || '—'}</div>
                    </td>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-muted)' }}>
                      {timeAgo(c.last_activity_at)}
                    </td>
                  </tr>

                  {expanded === c.id && (
                    <tr key={`${c.id}-expand`} className="expand-row">
                      <td colSpan={5}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 20 }}>

                          {/* Conversation log */}
                          <div>
                            <div className="section-hd" style={{ marginBottom: 10 }}>שיחה / Conversation</div>
                            <div className="conv-log">
                              {messages.length === 0
                                ? <div className="empty" style={{ padding: 16 }}>אין הודעות עדיין</div>
                                : messages.map((m, i) => (
                                  <div key={i}>
                                    {m.user_message && (
                                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                                        <div className="bubble user" dir="rtl">{m.user_message}</div>
                                        <div className="bubble-time">{formatTime(m.created_at)}</div>
                                      </div>
                                    )}
                                    {m.agent_response && (
                                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                                        <div className="bubble agent" dir="rtl">{m.agent_response}</div>
                                        <div className="bubble-time" style={{ textAlign: 'left' }}>{formatTime(m.created_at)}</div>
                                      </div>
                                    )}
                                  </div>
                                ))
                              }
                            </div>
                          </div>

                          {/* Edit panel */}
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                            <div className="section-hd">עריכה / Edit</div>

                            <div>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>שם / Name</div>
                              <input
                                className="input"
                                value={editing.name}
                                onChange={e => setEditing(p => ({ ...p, name: e.target.value }))}
                                placeholder="שם הליד"
                                dir="rtl"
                              />
                            </div>

                            <div>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>סטטוס / Status</div>
                              <select
                                className="select"
                                value={editing.status}
                                onChange={e => setEditing(p => ({ ...p, status: e.target.value }))}
                              >
                                {STATUS_OPTIONS.map(s => (
                                  <option key={s.value} value={s.value}>{s.label}</option>
                                ))}
                              </select>
                            </div>

                            <div>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>הערה ידנית / Note</div>
                              <textarea
                                className="textarea"
                                value={editing.notes}
                                onChange={e => setEditing(p => ({ ...p, notes: e.target.value }))}
                                placeholder="הוסף הערה..."
                                rows={3}
                                dir="rtl"
                              />
                            </div>

                            <div style={{ display: 'flex', gap: 8 }}>
                              <button className="btn btn-primary" onClick={() => handleSave(c.id)} disabled={saving}>
                                {saving ? 'שומר...' : 'שמור'}
                              </button>
                              <button className="btn btn-ghost" onClick={() => setExpanded(null)}>ביטול</button>
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
