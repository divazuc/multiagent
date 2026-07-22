import { useState, useEffect, useCallback } from 'react'
import Overview from './Overview.jsx'

const AGENT = import.meta.env.VITE_AGENT_URL || '/api/agent'
const DEFAULT_BIZ = '1037d6c1-e64f-4672-aa5c-19619ad6b821' // Leadz marketing
const BIZ_ID = new URLSearchParams(window.location.search).get('biz') || DEFAULT_BIZ

const STATUS_LABELS = {
  new: { label: 'חדש', cls: 'chip-new' },
  in_conversation: { label: 'בשיחה', cls: 'chip-active' },
  qualified: { label: 'ליד חם', cls: 'chip-hot' },
  closed: { label: 'טופל', cls: 'chip-done' },
}

const QUAL_LABELS = { need: 'צורך', scope: 'היקף', budget: 'תקציב', urgency: 'דחיפות', timeline: 'לו״ז' }

// Fallback fixtures so the page always demos well, marked as sample data
const SAMPLE_LEADS = [
  { id: 's1', phone: '972501234567', status: 'in_conversation', message_count: 8, last_activity_at: new Date(Date.now() - 22 * 60000).toISOString(), ai_summary: 'מעוניינת באתר תדמית לקליניקה. ביקשה הצעת מחיר והסוכן קבע איתה שיחת המשך למחר בבוקר.', _sample: true },
  { id: 's2', phone: '972529876543', status: 'new', message_count: 2, last_activity_at: new Date(Date.now() - 3 * 3600000).toISOString(), ai_summary: 'שאל על חנות אונליין עם סליקה. טרם השאיר פרטים — הסוכן ממתין לתשובה.', _sample: true },
  { id: 's3', phone: '972541112233', status: 'closed', message_count: 14, last_activity_at: new Date(Date.now() - 26 * 3600000).toISOString(), ai_summary: 'סגר חבילת אתר + דף נחיתה. הועבר לטיפול אנושי לחתימת הסכם.', _sample: true },
]

const SAMPLE_MESSAGES = [
  { user_message: 'היי, אני מחפשת מישהו שיבנה לי אתר לקליניקה', agent_response: 'היי! שמחה שפנית 😊 ספרי לי קצת — איזה סוג קליניקה, ויש לך אתר קיים או שמתחילים מאפס?', created_at: new Date(Date.now() - 40 * 60000).toISOString() },
  { user_message: 'קליניקת פיזיותרפיה, אין אתר בכלל', agent_response: 'מעולה, אז אתר תדמית עם עמוד קביעת תורים זה בדיוק מה שצריך. רוצה שנקבע שיחה קצרה מחר בבוקר לפרטים והצעת מחיר?', created_at: new Date(Date.now() - 30 * 60000).toISOString() },
  { user_message: 'כן, אשמח. אפשר ב-9:00?', agent_response: 'קבענו! 9:00 מחר בבוקר 📅 שלחתי לך אישור. יש עוד משהו שתרצי לדעת בינתיים?', created_at: new Date(Date.now() - 22 * 60000).toISOString() },
]

function formatPhone(p) {
  if (!p || !/^\d{10,}$/.test(p)) return p || '—'
  const local = p.startsWith('972') ? '0' + p.slice(3) : p
  return local.replace(/(\d{3})(\d{3})(\d+)/, '$1-$2-$3')
}

function timeAgo(ts) {
  if (!ts) return ''
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
  return new Date(ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
}

async function rpc(fn, ...args) {
  const res = await fetch(`${AGENT}/studio/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fn, args }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`)
  return body.result
}

export default function ClientDashboard() {
  const [view, setView] = useState('overview')
  const [bizName, setBizName] = useState('העסק שלך')
  const [leads, setLeads] = useState([])
  const [billing, setBilling] = useState(null)
  const [selected, setSelected] = useState(null)
  const [messages, setMessages] = useState([])
  const [qualification, setQualification] = useState(null)
  const [loadingThread, setLoadingThread] = useState(false)
  const [isSample, setIsSample] = useState(false)

  useEffect(() => {
    (async () => {
      try {
        const list = await rpc('listBusinesses')
        const biz = list.find(b => b.id === BIZ_ID)
        if (biz) setBizName(biz.name)
      } catch { /* keep default */ }

      try {
        const res = await fetch(`${AGENT}/contacts/${BIZ_ID}`)
        const body = await res.json()
        const contacts = (body.contacts || []).sort((a, b) => new Date(b.last_activity_at) - new Date(a.last_activity_at))
        if (contacts.length) {
          setLeads(contacts)
          selectLead(contacts[0])
        } else {
          setIsSample(true)
          setLeads(SAMPLE_LEADS)
          selectLead(SAMPLE_LEADS[0])
        }
      } catch {
        setIsSample(true)
        setLeads(SAMPLE_LEADS)
        selectLead(SAMPLE_LEADS[0])
      }

      try {
        const res = await fetch(`${AGENT}/billing/${BIZ_ID}`)
        setBilling(await res.json())
      } catch { /* KPI falls back */ }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectLead = useCallback(async (lead) => {
    setSelected(lead)
    setQualification(null)
    if (lead._sample) { setMessages(SAMPLE_MESSAGES); return }
    setLoadingThread(true)
    try {
      // Live sessions are keyed by the customer's phone number
      const state = await rpc('loadDBState', lead.phone)
      setMessages(state.messages || [])
      const qual = state.session?.qualification_progress
      if (qual && Object.values(qual).some(Boolean)) setQualification(qual)
    } catch {
      setMessages([])
    } finally {
      setLoadingThread(false)
    }
  }, [])

  const activeCount = leads.filter(l => l.status === 'in_conversation').length
  const totalMessages = leads.reduce((sum, l) => sum + (l.message_count || 0), 0)

  return (
    <div className="cd-page">
      {/* ── Header band ── */}
      <header className="cd-header">
        <div className="cd-header-inner">
          <div className="cd-brand">
            <div className="cd-brand-mark">💬</div>
            <div>
              <h1 className="cd-title">מרכז הלידים</h1>
              <div className="cd-biz-name">{bizName}</div>
            </div>
          </div>
          <nav className="cd-tabs" aria-label="תצוגות">
            <button className={view === 'overview' ? 'active' : ''} onClick={() => setView('overview')}>
              סקירה עסקית
            </button>
            <button className={view === 'inbox' ? 'active' : ''} onClick={() => setView('inbox')}>
              מרכז הלידים
            </button>
          </nav>
          <div className="cd-agent-badge">
            <span className="cd-agent-dot" />
            הסוכן שלך פעיל · עונה ללקוחות 24/7
          </div>
        </div>
      </header>

      <main className="cd-main">
        {view === 'overview' && <Overview bizId={BIZ_ID} />}

        {view === 'inbox' && <>
        {/* ── KPI strip ── */}
        <section className="cd-kpis" aria-label="נתונים עיקריים">
          <div className="cd-kpi">
            <div className="cd-kpi-value">{leads.length}</div>
            <div className="cd-kpi-label">לידים בתיבה</div>
          </div>
          <div className="cd-kpi">
            <div className="cd-kpi-value">{activeCount}</div>
            <div className="cd-kpi-label">בשיחה פעילה</div>
          </div>
          <div className="cd-kpi">
            <div className="cd-kpi-value">{totalMessages}</div>
            <div className="cd-kpi-label">הודעות שהסוכן טיפל בהן</div>
          </div>
          <div className="cd-kpi cd-kpi-accent">
            <div className="cd-kpi-value">{billing?.estimated_cost_usd > 0 ? `₪${billing.estimated_cost_ils}` : 'חינם'}</div>
            <div className="cd-kpi-label">עלות הודעות החודש</div>
          </div>
        </section>

        <div className="cd-grid">
          {/* ── Lead inbox ── */}
          <section className="cd-inbox" aria-label="תיבת לידים">
            <div className="cd-section-head">
              <h2>תיבת לידים</h2>
              {isSample && <span className="cd-sample-chip">נתוני הדגמה</span>}
            </div>
            <div className="cd-lead-list">
              {leads.map(lead => {
                const st = STATUS_LABELS[lead.status] || { label: lead.status, cls: 'chip-done' }
                const isSel = selected?.id === lead.id
                return (
                  <button
                    key={lead.id}
                    className={`cd-lead ${isSel ? 'selected' : ''}`}
                    onClick={() => selectLead(lead)}
                  >
                    <div className="cd-lead-top">
                      <span className="cd-lead-phone">{lead.name || formatPhone(lead.phone)}</span>
                      <span className="cd-lead-time">{timeAgo(lead.last_activity_at)}</span>
                    </div>
                    <div className="cd-lead-mid">
                      <span className={`cd-chip ${st.cls}`}>{st.label}</span>
                      <span className="cd-lead-count">{lead.message_count} הודעות</span>
                    </div>
                    {lead.ai_summary && (
                      <div className="cd-lead-summary">
                        <span className="cd-ai-tag">🤖 סיכום הסוכן</span>
                        {lead.ai_summary}
                      </div>
                    )}
                  </button>
                )
              })}
              {leads.length === 0 && (
                <div className="cd-empty">כשלקוחות יכתבו לוואטסאפ של העסק — הלידים יופיעו כאן</div>
              )}
            </div>
          </section>

          {/* ── Lead detail + conversation ── */}
          <section className="cd-detail" aria-label="פרטי ליד">
            {selected ? (
              <>
                <div className="cd-customer-card">
                  <div className="cd-customer-head">
                    <div className="cd-avatar">{selected.name ? selected.name.slice(0, 1) : '👤'}</div>
                    <div>
                      <div className="cd-customer-name">{selected.name || formatPhone(selected.phone)}</div>
                      <div className="cd-customer-meta">
                        לקוח מאז {new Date(selected.created_at || Date.now()).toLocaleDateString('he-IL')}
                        {' · '}{selected.message_count} הודעות
                      </div>
                    </div>
                    <span className={`cd-chip ${(STATUS_LABELS[selected.status] || {}).cls || 'chip-done'}`} style={{ marginRight: 'auto' }}>
                      {(STATUS_LABELS[selected.status] || {}).label || selected.status}
                    </span>
                  </div>

                  {qualification && (
                    <div className="cd-qual">
                      <div className="cd-qual-title">מה הסוכן כבר יודע על הלקוח</div>
                      <div className="cd-qual-chips">
                        {Object.entries(qualification).filter(([, v]) => v).map(([k, v]) => (
                          <span key={k} className="cd-qual-chip">
                            <b>{QUAL_LABELS[k] || k}:</b> {String(v).replace(/_/g, ' ')}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="cd-thread">
                  <div className="cd-thread-head">השיחה האחרונה</div>
                  <div className="cd-thread-body">
                    {loadingThread && <div className="cd-empty">טוען שיחה…</div>}
                    {!loadingThread && messages.length === 0 && (
                      <div className="cd-empty">אין הודעות שמורות לשיחה זו</div>
                    )}
                    {!loadingThread && messages.map((m, i) => (
                      <div key={i} className="cd-exchange">
                        {m.user_message && (
                          <div className="cd-bubble cd-bubble-in">
                            {m.user_message}
                            <span className="cd-bubble-time">{msgTime(m.created_at)}</span>
                          </div>
                        )}
                        {m.agent_response && (
                          <div className="cd-bubble cd-bubble-out">
                            {m.agent_response}
                            <span className="cd-bubble-time">{msgTime(m.created_at)} ✓✓</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <div className="cd-empty" style={{ margin: 'auto' }}>בחרו ליד מהרשימה</div>
            )}
          </section>
        </div>
        </>}
      </main>

      <footer className="cd-footer">
        הנתונים מתעדכנים אוטומטית מכל שיחה שהסוכן מנהל בוואטסאפ
      </footer>
    </div>
  )
}
