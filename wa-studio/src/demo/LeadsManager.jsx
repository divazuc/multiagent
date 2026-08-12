import { useState, useEffect, useMemo, useCallback, useRef } from 'react'

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

// The trial-reminders panel's own date default — today, in Israel (the
// board's dates are all trial DATES, an Israel wall date, never UTC).
function todayJerusalem() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' })
}

function resultLabel(status) {
  if (status === 'sent' || status === 'template_sent') return 'נשלח ✓'
  if (status === 'dry_run') return 'הרצת ניסיון'
  return 'נכשל'
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

export default function LeadsManager({ api, showToast, autoOpenReminders = false }) {
  const [board, setBoard] = useState(null) // { enabled, ready, leads, counts, statuses }
  const [statusFilter, setStatusFilter] = useState(null) // null = הכל
  const [query, setQuery] = useState('')
  const [notesDraft, setNotesDraft] = useState(null) // { id, text }

  // Trial-day reminders (owner-in-the-loop manual send). The api client
  // exposes these ops only on the studio surface (createDemoApi) — the
  // client portal doesn't get this button, feature-detected rather than
  // threading a prop through every caller.
  const remindersSupported = typeof api.previewTrialReminders === 'function'
  const [reminders, setReminders] = useState(null) // { date, mode, test_recipient, leads, checked, loading, sending, results }
  const autoOpenedRef = useRef(false)

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

  // Loads the preview for one date; already-sent leads default UNCHECKED
  // (re-sending is a deliberate re-check), everyone else defaults CHECKED —
  // the owner unchecks who said they won't come.
  async function openReminders(date) {
    const d = date || todayJerusalem()
    setReminders({ date: d, mode: null, test_recipient: null, leads: [], checked: new Set(), loading: true, sending: false, results: null })
    try {
      const out = await api.previewTrialReminders(d)
      const checked = new Set(out.leads.filter(l => !l.already_sent).map(l => l.id))
      setReminders({ date: d, mode: out.mode, test_recipient: out.test_recipient, leads: out.leads, checked, loading: false, sending: false, results: null })
    } catch {
      setReminders({ date: d, mode: null, test_recipient: null, leads: [], checked: new Set(), loading: false, sending: false, results: null })
      showToast?.('טעינת רשימת התזכורות נכשלה — נסו שוב')
    }
  }

  function toggleReminderLead(id) {
    setReminders(r => {
      if (!r) return r
      const checked = new Set(r.checked)
      checked.has(id) ? checked.delete(id) : checked.add(id)
      return { ...r, checked }
    })
  }

  async function sendReminders() {
    if (!reminders || reminders.sending || reminders.checked.size === 0) return
    const ids = [...reminders.checked]
    setReminders(r => ({ ...r, sending: true }))
    try {
      const out = await api.sendTrialReminders(reminders.date, ids)
      showToast?.(`נשלחו ${out.sent_count}/${out.requested} תזכורות ✓`)
      // Reload the same date — refreshes the "כבר נשלחה" badges and shows
      // each row's per-lead result without a second round trip.
      const preview = await api.previewTrialReminders(reminders.date)
      setReminders(r => ({
        ...r, mode: preview.mode, test_recipient: preview.test_recipient,
        leads: preview.leads, sending: false, results: out.results,
      }))
    } catch {
      setReminders(r => ({ ...r, sending: false }))
      showToast?.('שליחת התזכורות נכשלה — נסו שוב')
    }
  }

  // The daily-scheduler's Telegram notice links here with ?remind=1 — open
  // straight to today's reminders once the board itself is ready. Fires at
  // most once (autoOpenedRef), so a later board refresh never re-opens it.
  useEffect(() => {
    if (autoOpenReminders && remindersSupported && board?.enabled && !autoOpenedRef.current) {
      autoOpenedRef.current = true
      openReminders(todayJerusalem())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpenReminders, remindersSupported, board?.enabled])

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
          {remindersSupported && (
            <button className="lm-csv" onClick={() => openReminders(todayJerusalem())}>
              🔔 תזכורות ניסיון
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

      {reminders && (
        <div className="lm-convo-overlay" onClick={() => setReminders(null)}>
          <aside
            className="lm-convo lm-reminders"
            role="dialog"
            aria-label="תזכורות ניסיון"
            onClick={e => e.stopPropagation()}
          >
            <header className="lm-convo-head">
              <div className="lm-convo-who">
                <strong>🔔 תזכורות ניסיון</strong>
                <input
                  className="lm-reminders-date"
                  type="date"
                  value={reminders.date}
                  onChange={e => openReminders(e.target.value)}
                  aria-label="תאריך"
                />
              </div>
              <div className="lm-convo-actions">
                <button className="lm-convo-close" onClick={() => setReminders(null)} aria-label="סגירה">✕</button>
              </div>
            </header>

            {reminders.mode === 'test_redirect' && (
              <div className="lm-reminders-banner">
                מצב בדיקה — כל השליחות יופנו ל-{formatPhone(reminders.test_recipient)}, אף ליד אמיתי לא יקבל הודעה
              </div>
            )}
            {reminders.mode === 'dry_run' && (
              <div className="lm-reminders-banner">מצב הרצת ניסיון — התזכורות לא יישלחו בפועל (המנגנון כבוי)</div>
            )}

            <div className="lm-convo-body">
              {reminders.loading && <div className="cd-empty">טוען…</div>}
              {!reminders.loading && reminders.leads.length === 0 && (
                <div className="cd-empty">אין רישומים לניסיון בתאריך הזה</div>
              )}
              {!reminders.loading && reminders.leads.length > 0 && (
                <ul className="lm-reminders-list">
                  {reminders.leads.map(l => {
                    const result = reminders.results?.find(r => r.id === l.id)
                    return (
                      <li key={l.id} className="lm-reminders-row">
                        <label>
                          <input
                            type="checkbox"
                            checked={reminders.checked.has(l.id)}
                            onChange={() => toggleReminderLead(l.id)}
                          />
                          <span>{l.child_name || l.display_name || formatPhone(l.phone)}</span>
                          <span dir="ltr">{formatPhone(l.phone)}</span>
                          {l.trial_time && <span>{l.trial_time}</span>}
                        </label>
                        {result
                          ? <span className={`lm-reminder-result lm-reminder-result-${result.status}`}>{resultLabel(result.status)}</span>
                          : l.already_sent && (
                            <span className="lm-reminded" title={l.reminder_sent_at ?? ''}>כבר נשלחה תזכורת ✓</span>
                          )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>

            <footer className="lm-reminders-foot">
              <span>{reminders.checked.size} מסומנים מתוך {reminders.leads.length}</span>
              <button
                className="cd-qa cd-qa-primary"
                disabled={reminders.sending || reminders.checked.size === 0}
                onClick={sendReminders}
              >
                {reminders.sending ? 'שולח…' : 'שלח תזכורת'}
              </button>
            </footer>
          </aside>
        </div>
      )}
    </section>
  )
}
