import { useState, useEffect, useMemo, useCallback } from 'react'

// ניהול לידים — the per-business lead board (the `leads` module).
// EVERY number that wrote to the bot, in status lists the conversation itself
// advances (server/lib/leads.js); here the owner tracks trial signups, kids'
// ages and contacted-or-not, edits statuses/notes inline, and downloads the
// CSV that replaces the Google Sheet. Status keys AND Hebrew labels come from
// the server response — the copy is centralized there, not here.

const EMPTY_COPY = 'עוד אין לידים — כשמישהו יכתוב לוואטסאפ, הוא יופיע כאן.'
const EMPTY_CONVO_COPY = 'אין עדיין שיחה עם המספר הזה'
const OWNER_ECHO_LABEL = 'המאמנת (מהאפליקציה)'

function formatPhone(p) {
  if (!p || !/^\d{10,}$/.test(p)) return p || '—'
  const local = p.startsWith('972') ? '0' + p.slice(3) : p
  return local.replace(/(\d{3})(\d{3})(\d+)/, '$1-$2-$3')
}

function timeAgo(ts) {
  if (!ts) return '—'
  const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60000)
  if (mins < 1) return 'עכשיו'
  if (mins < 60) return `לפני ${mins} דק׳`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `לפני ${hrs} שע׳`
  const days = Math.round(hrs / 24)
  if (days === 1) return 'אתמול'
  return `לפני ${days} ימים`
}

function msgTime(ts) {
  if (!ts) return ''
  try { return new Date(ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) } catch { return '' }
}

function msgDay(ts) {
  if (!ts) return ''
  try { return new Date(ts).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' }) } catch { return '' }
}

// '2026-08-14' → '14/08' — the trial date the sheet sync banks on the payload.
function formatTrialDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '')
  return m ? `${m[3]}/${m[2]}` : null
}

function trialDetails(payload) {
  const parts = []
  if (payload?.child_name) parts.push(payload.child_name)
  if (payload?.child_age) parts.push(`גיל ${payload.child_age}`)
  const date = formatTrialDate(payload?.trial_date)
  if (date) parts.push(payload?.trial_time ? `ניסיון ${date} בשעה ${payload.trial_time}` : `ניסיון ${date}`)
  else if (payload?.preferred_day) parts.push(payload.preferred_day)
  return parts.length ? parts.join(' · ') : null
}

export default function LeadsManager({ api, showToast }) {
  const [board, setBoard] = useState(null) // { enabled, ready, leads, counts, statuses }
  const [statusFilter, setStatusFilter] = useState(null) // null = הכל
  const [query, setQuery] = useState('')
  const [notesDraft, setNotesDraft] = useState(null) // { id, text }

  const load = useCallback(async () => {
    try {
      setBoard(await api.listLeads())
    } catch {
      setBoard({ enabled: true, ready: false, leads: [], counts: { all: 0 }, statuses: [] })
    }
  }, [api])
  useEffect(() => { load() }, [load])

  const leads = board?.leads ?? []
  const statuses = board?.statuses ?? []
  const labelOf = useCallback(
    (key) => statuses.find(s => s.key === key)?.label ?? key,
    [statuses])

  // Counts recompute locally so an inline status change moves the pills
  // immediately — the loaded list is the whole board, never a filtered page.
  const counts = useMemo(() => {
    const c = { all: leads.length }
    for (const s of statuses) c[s.key] = 0
    for (const l of leads) if (c[l.status] !== undefined) c[l.status] += 1
    return c
  }, [leads, statuses])

  const filtered = useMemo(() => {
    const q = query.trim().replace(/-/g, '')
    return leads.filter(l => {
      if (statusFilter && l.status !== statusFilter) return false
      if (q) {
        const local = l.phone?.startsWith('972') ? '0' + l.phone.slice(3) : ''
        const hay = [l.phone, local, l.display_name, l.payload?.parent_name, l.payload?.child_name, l.notes]
          .filter(Boolean).join(' ').replace(/-/g, '')
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [leads, statusFilter, query])

  async function changeStatus(lead, status) {
    const prev = lead.status
    setBoard(b => ({ ...b, leads: b.leads.map(l => l.id === lead.id ? { ...l, status } : l) }))
    try {
      await api.updateLead(lead.id, { status })
      showToast?.('הסטטוס עודכן ✓')
    } catch {
      setBoard(b => ({ ...b, leads: b.leads.map(l => l.id === lead.id ? { ...l, status: prev } : l) }))
      showToast?.('עדכון הסטטוס נכשל — נסו שוב')
    }
  }

  async function saveNotes() {
    if (!notesDraft) return
    const { id, text } = notesDraft
    const clean = text.trim() || null
    setNotesDraft(null)
    setBoard(b => ({ ...b, leads: b.leads.map(l => l.id === id ? { ...l, notes: clean } : l) }))
    try {
      await api.updateLead(id, { notes: clean })
      showToast?.('ההערה נשמרה ✓')
    } catch {
      showToast?.('שמירת ההערה נכשלה — נסו שוב')
      load()
    }
  }

  // "סנכרון מהגיליון" — pull the trial-registration sheet now (the morning
  // cron does the same sync automatically before sending reminders).
  const [syncing, setSyncing] = useState(false)
  async function syncFromSheet() {
    if (syncing) return
    setSyncing(true)
    try {
      const out = await api.syncLeadsSheet()
      showToast?.(`סונכרן מהגיליון ✓ (${out?.updated ?? 0} לידים עודכנו)`)
      load()
    } catch {
      showToast?.('הסנכרון מהגיליון נכשל — נסו שוב')
    } finally {
      setSyncing(false)
    }
  }

  // In-app conversation view — the owner works from a computer, so the phone
  // click opens the transcript HERE (wa.me stays as a small secondary icon
  // for the rare real-phone handoff).
  const [convo, setConvo] = useState(null) // { lead, loading, messages }
  async function openConvo(lead) {
    setConvo({ lead, loading: true, messages: [] })
    try {
      const out = await api.getLeadConversation(lead.phone)
      setConvo(c => (c?.lead?.id === lead.id ? { lead, loading: false, messages: out?.messages ?? [] } : c))
    } catch {
      setConvo(c => (c?.lead?.id === lead.id ? { lead, loading: false, messages: [] } : c))
    }
  }

  async function downloadCsv() {
    try {
      const { filename, csv } = await api.exportLeadsCsv()
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      showToast?.('קובץ הלידים ירד ✓')
    } catch {
      showToast?.('הייצוא נכשל — נסו שוב')
    }
  }

  if (!board) return <div className="cd-empty">טוען לידים…</div>
  if (!board.enabled) return null // the tab shouldn't even render — belt and braces

  return (
    <section className="lm-wrap" aria-label="ניהול לידים">
      <div className="lm-head">
        <h2 className="lm-title">ניהול לידים</h2>
        <div className="lm-tools">
          <input
            className="lm-search"
            type="search"
            placeholder="חיפוש לפי שם, טלפון או הערה…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {board.sheet_configured && (
            <button className="lm-csv lm-sync" onClick={syncFromSheet} disabled={syncing}>
              {syncing ? 'מסנכרן…' : '⟳ סנכרון מהגיליון'}
            </button>
          )}
          <button className="lm-csv" onClick={downloadCsv} disabled={!leads.length}>
            ⬇ הורדת CSV
          </button>
        </div>
      </div>

      <div className="lm-pills" role="tablist" aria-label="סינון לפי סטטוס">
        <button
          className={`lm-pill ${statusFilter === null ? 'on' : ''}`}
          onClick={() => setStatusFilter(null)}
        >
          הכל <i>{counts.all}</i>
        </button>
        {statuses.map(s => (
          <button
            key={s.key}
            className={`lm-pill ${s.key === 'joined' ? 'lm-pill-joined' : ''} ${statusFilter === s.key ? 'on' : ''}`}
            onClick={() => setStatusFilter(f => f === s.key ? null : s.key)}
          >
            {s.key === 'joined' && '🎉 '}{s.label} <i>{counts[s.key] ?? 0}</i>
          </button>
        ))}
      </div>

      {leads.length === 0 && <div className="cd-empty">{EMPTY_COPY}</div>}
      {leads.length > 0 && filtered.length === 0 && (
        <div className="cd-empty">אין לידים שמתאימים לסינון — נסו לנקות את החיפוש</div>
      )}

      {filtered.length > 0 && (
        <div className="lm-table-wrap">
          <table className="lm-table">
            <thead>
              <tr>
                <th>טלפון</th>
                <th>שם</th>
                <th>פרטי ניסיון</th>
                <th>פנייה אחרונה</th>
                <th>סטטוס</th>
                <th>הערות</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(lead => (
                <tr key={lead.id} className={`lm-row-${lead.status}`}>
                  <td className="lm-phone">
                    <button
                      className="lm-phone-btn"
                      title="צפייה בשיחה"
                      onClick={() => openConvo(lead)}
                    >
                      {formatPhone(lead.phone)}
                    </button>
                    <a
                      className="lm-wa-link"
                      href={`https://wa.me/${lead.phone}`}
                      target="_blank"
                      rel="noreferrer"
                      title="פתיחה בוואטסאפ"
                    >
                      ↗
                    </a>
                  </td>
                  <td>{lead.display_name || lead.payload?.parent_name || '—'}</td>
                  <td className="lm-trial">
                    {trialDetails(lead.payload) ?? '—'}
                    {lead.payload?.reminder_sent_on && (
                      <span
                        className="lm-reminded"
                        title={`תזכורת ליום האימון נשלחה ב־${lead.payload.reminder_sent_on}`}
                      >
                        תזכורת נשלחה ✓
                      </span>
                    )}
                  </td>
                  <td className="lm-time" title={lead.last_contact_at ?? ''}>
                    {timeAgo(lead.last_contact_at)}
                    {lead.last_direction === 'out' && <span className="lm-dir" title="ההודעה האחרונה נשלחה מהעסק"> ↩</span>}
                  </td>
                  <td className="lm-status-cell">
                    {/* the dot repeats the status color; the TEXT in the select
                        stays the real signal (color-blind safe) */}
                    <i className={`lm-dot lm-dot-${lead.status}`} aria-hidden="true" />
                    <select
                      className={`lm-select ${lead.status === 'joined' ? 'lm-select-joined' : ''}`}
                      value={lead.status}
                      aria-label={`סטטוס עבור ${formatPhone(lead.phone)}`}
                      onChange={e => changeStatus(lead, e.target.value)}
                    >
                      {statuses.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                      {!statuses.some(s => s.key === lead.status) && (
                        <option value={lead.status}>{labelOf(lead.status)}</option>
                      )}
                    </select>
                  </td>
                  <td className="lm-notes">
                    {notesDraft?.id === lead.id ? (
                      <span className="lm-notes-edit">
                        <textarea
                          autoFocus
                          rows={2}
                          value={notesDraft.text}
                          placeholder="למשל: לחזור אחרי 17:00"
                          onChange={e => setNotesDraft(d => ({ ...d, text: e.target.value }))}
                          onKeyDown={e => {
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveNotes() }
                            if (e.key === 'Escape') setNotesDraft(null)
                          }}
                        />
                        <span className="lm-notes-actions">
                          <button className="cd-qa" onClick={() => setNotesDraft(null)}>ביטול</button>
                          <button className="cd-qa cd-qa-primary" onClick={saveNotes}>שמירה</button>
                        </span>
                      </span>
                    ) : (
                      <button
                        className="lm-notes-btn"
                        onClick={() => setNotesDraft({ id: lead.id, text: lead.notes ?? '' })}
                        title="עריכת הערה"
                      >
                        {lead.notes || <span className="lm-notes-empty">+ הערה</span>}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="lm-foot">הסטטוסים מתעדכנים אוטומטית מהשיחה בוואטסאפ · אפשר גם לעדכן ידנית</div>

      {convo && (
        <div className="lm-convo-overlay" onClick={() => setConvo(null)}>
          <aside
            className="lm-convo"
            role="dialog"
            aria-label={`שיחה עם ${formatPhone(convo.lead.phone)}`}
            onClick={e => e.stopPropagation()}
          >
            <header className="lm-convo-head">
              <div className="lm-convo-who">
                <strong>{convo.lead.display_name || convo.lead.payload?.parent_name || formatPhone(convo.lead.phone)}</strong>
                <span dir="ltr">{formatPhone(convo.lead.phone)}</span>
              </div>
              <div className="lm-convo-actions">
                <a
                  className="lm-wa-link"
                  href={`https://wa.me/${convo.lead.phone}`}
                  target="_blank"
                  rel="noreferrer"
                  title="פתיחה בוואטסאפ"
                >
                  ↗
                </a>
                <button className="lm-convo-close" onClick={() => setConvo(null)} aria-label="סגירה">✕</button>
              </div>
            </header>
            <div className="lm-convo-body">
              {convo.loading && <div className="cd-empty">טוען שיחה…</div>}
              {!convo.loading && convo.messages.length === 0 && (
                <div className="cd-empty">{EMPTY_CONVO_COPY}</div>
              )}
              {!convo.loading && convo.messages.map((m, i) => {
                const day = msgDay(m.created_at)
                const daySep = day && day !== msgDay(convo.messages[i - 1]?.created_at)
                return (
                  <div key={i} className="lm-convo-turn">
                    {daySep && <div className="lm-convo-day">{day}</div>}
                    {m.user_message && (
                      <div className="cd-bubble cd-bubble-in">
                        {m.user_message}
                        <span className="cd-bubble-time">{msgTime(m.created_at)}</span>
                      </div>
                    )}
                    {m.agent_response && (
                      <div className={`cd-bubble cd-bubble-out ${m.action === 'owner_echo' ? 'lm-bubble-owner' : ''}`}>
                        {m.action === 'owner_echo' && (
                          <span className="lm-bubble-owner-tag">{OWNER_ECHO_LABEL}</span>
                        )}
                        {m.agent_response}
                        <span className="cd-bubble-time">{msgTime(m.created_at)}</span>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </aside>
        </div>
      )}
    </section>
  )
}
