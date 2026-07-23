import { useState, useEffect, useCallback, useMemo } from 'react'
import Overview from './Overview.jsx'
import { DemoFaq, DemoSettings } from './FaqSettings.jsx'
import { createDemoApi } from './api.js'

const DEFAULT_BIZ = '1037d6c1-e64f-4672-aa5c-19619ad6b821' // Leadz marketing
const BIZ_ID = new URLSearchParams(window.location.search).get('biz') || DEFAULT_BIZ

// Covers both the seeded demo statuses and the live pipeline's ladder
// (new_lead → in_conversation → cta_triggered → followup_sent → converted).
const STATUS_LABELS = {
  new: { label: 'חדש', cls: 'chip-new' },
  new_lead: { label: 'חדש', cls: 'chip-new' },
  in_conversation: { label: 'בשיחה', cls: 'chip-active' },
  qualified: { label: 'ליד חם', cls: 'chip-hot' },
  cta_triggered: { label: 'ליד חם', cls: 'chip-hot' },
  followup_sent: { label: 'נשלח פולו-אפ', cls: 'chip-active' },
  converted: { label: 'טופל', cls: 'chip-done' },
  closed: { label: 'טופל', cls: 'chip-done' },
  cold: { label: 'לא פעיל', cls: 'chip-done' },
  not_relevant: { label: 'לא רלוונטי', cls: 'chip-done' },
}

const QUAL_LABELS = { need: 'צורך', scope: 'היקף', budget: 'תקציב', urgency: 'דחיפות', timeline: 'לו״ז' }

// Smart tags — derived from the agent's AI summary per lead
const TAG_DEFS = [
  { key: 'botox', label: 'בוטוקס', re: /בוטוקס/ },
  { key: 'lips', label: 'מילוי שפתיים', re: /שפתיים/ },
  { key: 'laser', label: 'טיפולי לייזר', re: /לייזר/ },
  { key: 'profhilo', label: 'פרופיילו', re: /פרופיילו/ },
  { key: 'mezo', label: 'מזותרפיה', re: /מזותרפיה/ },
  { key: 'hair', label: 'השתלת שיער', re: /השתלת שיער|קו שיער|קו קדמי|נשירה/ },
  { key: 'brows', label: 'השתלת גבות', re: /גבות/ },
  { key: 'beard', label: 'השתלת זקן', re: /זקן/ },
  { key: 'doctors', label: 'קורס לרופאים', re: /קורס|סילבוס|רופא|הדרכה/ },
  { key: 'rep', label: 'ממתין לנציגה', re: /נועה|נציגה|הועבר ל/ },
  { key: 'pricing', label: 'שאלת מחיר', re: /מחיר/ },
  { key: 'medical', label: 'שאלה רפואית', re: /הריון|רפואי/ },
]

function leadTags(lead) {
  const text = `${lead.ai_summary || ''} ${lead.notes || ''}`
  return TAG_DEFS.filter(t => t.re.test(text)).map(t => t.key)
}

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

function followUpText(lead) {
  const name = lead.name ? lead.name.split(' ')[0] : ''
  const tag = TAG_DEFS.find(t => leadTags(lead).includes(t.key) && !['rep', 'pricing', 'medical'].includes(t.key))
  const topic = tag ? tag.label : 'הטיפול שהתעניינת בו'
  return `היי${name ? ' ' + name : ''}, כאן אסתטיק קליניק 🤍 רצינו לוודא שקיבלת את כל המידע על ${topic}. נשמח לתאם לך פגישת ייעוץ עם ד״ר לביא — מתי נוח לך?`
}

export default function ClientDashboard({ api: apiProp = null, businessName = null, onLogout = null }) {
  const api = useMemo(() => apiProp ?? createDemoApi(BIZ_ID), [apiProp])
  const [view, setView] = useState('overview')
  const [bizName, setBizName] = useState(businessName || 'העסק שלך')
  const [leads, setLeads] = useState([])
  const [billing, setBilling] = useState(null)
  const [selected, setSelected] = useState(null)
  const [messages, setMessages] = useState([])
  const [qualification, setQualification] = useState(null)
  const [loadingThread, setLoadingThread] = useState(false)
  const [isSample, setIsSample] = useState(false)

  // search + filters
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeTags, setActiveTags] = useState([])
  const [statusFilter, setStatusFilter] = useState(null)

  // quick actions
  const [composer, setComposer] = useState(null) // null | {mode:'followup'|'free', text}
  const [toast, setToast] = useState(null)

  useEffect(() => {
    (async () => {
      try {
        const name = await api.getBusinessName()
        if (name) setBizName(name)
      } catch { /* keep default */ }

      try {
        const contacts = (await api.listContacts()).sort((a, b) => new Date(b.last_activity_at) - new Date(a.last_activity_at))
        if (contacts.length) {
          setLeads(contacts)
          selectLead(contacts[0])
        } else if (!onLogout) {
          // sample fixtures are a demo-only affordance — the real portal shows an empty state
          setIsSample(true)
          setLeads(SAMPLE_LEADS)
          selectLead(SAMPLE_LEADS[0])
        }
      } catch {
        if (!onLogout) {
          setIsSample(true)
          setLeads(SAMPLE_LEADS)
          selectLead(SAMPLE_LEADS[0])
        }
      }

      try {
        setBilling(await api.getBilling())
      } catch { /* KPI falls back */ }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  const selectLead = useCallback(async (lead) => {
    setSelected(lead)
    setQualification(null)
    setComposer(null)
    if (lead._sample) { setMessages(SAMPLE_MESSAGES); return }
    setLoadingThread(true)
    try {
      // Live sessions are keyed by the customer's phone number
      const state = await api.loadThread(lead.phone)
      setMessages(state.messages || [])
      const qual = state.session?.qualification_progress
      if (qual && Object.values(qual).some(Boolean)) setQualification(qual)
    } catch {
      setMessages([])
    } finally {
      setLoadingThread(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  // tag counts across all leads (for the filter chips)
  const tagCounts = useMemo(() => {
    const counts = {}
    for (const l of leads) for (const t of leadTags(l)) counts[t] = (counts[t] || 0) + 1
    return counts
  }, [leads])

  const statusCounts = useMemo(() => {
    const counts = {}
    for (const l of leads) {
      const label = (STATUS_LABELS[l.status] || {}).label || l.status
      counts[label] = (counts[label] || 0) + 1
    }
    return counts
  }, [leads])

  const filtered = useMemo(() => {
    const q = query.trim()
    return leads.filter(l => {
      if (q) {
        const phoneLocal = l.phone?.startsWith('972') ? '0' + l.phone.slice(3) : (l.phone || '')
        const hay = `${l.name || ''} ${l.phone || ''} ${phoneLocal} ${formatPhone(l.phone)}`.replace(/-/g, '')
        if (!hay.includes(q.replace(/-/g, ''))) return false
      }
      if (activeTags.length) {
        const tags = leadTags(l)
        if (!activeTags.some(t => tags.includes(t))) return false
      }
      if (statusFilter) {
        const label = (STATUS_LABELS[l.status] || {}).label || l.status
        if (label !== statusFilter) return false
      }
      return true
    })
  }, [leads, query, activeTags, statusFilter])

  const filtersActive = query.trim() || activeTags.length > 0 || statusFilter

  function showToast(text) {
    setToast(text)
    setTimeout(() => setToast(null), 3200)
  }

  function sendComposer() {
    if (!composer?.text.trim()) return
    setMessages(prev => [...prev, { agent_response: composer.text.trim(), created_at: new Date().toISOString(), _manual: true }])
    setComposer(null)
    showToast('ההודעה נשלחה לוואטסאפ של הלקוח ✓')
    if (composer.mode === 'followup' && selected && !selected._sample) {
      setLeads(prev => prev.map(l => l.id === selected.id ? { ...l, status: 'followup_sent' } : l))
      setSelected(prev => ({ ...prev, status: 'followup_sent' }))
    }
  }

  async function markHandled() {
    if (!selected) return
    const updated = { ...selected, status: 'closed' }
    setSelected(updated)
    setLeads(prev => prev.map(l => l.id === selected.id ? updated : l))
    showToast('הליד סומן כטופל ✓')
    if (!selected._sample) {
      try {
        await api.updateContact(selected.id, { status: 'closed' })
      } catch { /* optimistic UI keeps the change */ }
    }
  }

  const activeCount = leads.filter(l => ['in_conversation'].includes(l.status)).length
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
            <button className={view === 'faq' ? 'active' : ''} onClick={() => setView('faq')}>
              שאלות ותשובות
            </button>
            <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>
              הגדרות
            </button>
          </nav>
          <div className="cd-header-side">
            <div className="cd-agent-badge">
              <span className="cd-agent-dot" />
              הסוכן שלך פעיל · עונה ללקוחות 24/7
            </div>
            {onLogout && (
              <button className="cd-logout" onClick={onLogout}>יציאה</button>
            )}
          </div>
        </div>
      </header>

      <main className="cd-main">
        {view === 'overview' && <Overview api={api} />}
        {view === 'faq' && <DemoFaq api={api} showToast={showToast} />}
        {view === 'settings' && <DemoSettings api={api} showToast={showToast} />}

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
              <div className="cd-head-tools">
                {isSample && <span className="cd-sample-chip">נתוני הדגמה</span>}
                <button
                  className={`cd-search-toggle ${searchOpen || filtersActive ? 'on' : ''}`}
                  onClick={() => setSearchOpen(o => !o)}
                  aria-expanded={searchOpen}
                >
                  🔍 חיפוש מתקדם{filtersActive ? ` · ${filtered.length}` : ''}
                </button>
              </div>
            </div>

            {searchOpen && (
              <div className="cd-search-panel">
                <input
                  className="cd-search-input"
                  type="search"
                  placeholder="חיפוש לפי שם או טלפון…"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                />
                <div className="cd-filter-group">
                  <div className="cd-filter-label">תגיות חכמות</div>
                  <div className="cd-filter-chips">
                    {TAG_DEFS.filter(t => tagCounts[t.key]).map(t => (
                      <button
                        key={t.key}
                        className={`cd-ftag ${activeTags.includes(t.key) ? 'on' : ''}`}
                        onClick={() => setActiveTags(prev => prev.includes(t.key) ? prev.filter(x => x !== t.key) : [...prev, t.key])}
                      >
                        {t.label} <i>{tagCounts[t.key]}</i>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="cd-filter-group">
                  <div className="cd-filter-label">סטטוס</div>
                  <div className="cd-filter-chips">
                    {Object.entries(statusCounts).map(([label, n]) => (
                      <button
                        key={label}
                        className={`cd-ftag ${statusFilter === label ? 'on' : ''}`}
                        onClick={() => setStatusFilter(s => s === label ? null : label)}
                      >
                        {label} <i>{n}</i>
                      </button>
                    ))}
                  </div>
                </div>
                {filtersActive && (
                  <button className="cd-clear-filters" onClick={() => { setQuery(''); setActiveTags([]); setStatusFilter(null) }}>
                    ניקוי הסינון · מציג {filtered.length} מתוך {leads.length}
                  </button>
                )}
              </div>
            )}

            <div className="cd-lead-list">
              {filtered.map(lead => {
                const st = STATUS_LABELS[lead.status] || { label: lead.status, cls: 'chip-done' }
                const isSel = selected?.id === lead.id
                const tags = leadTags(lead).slice(0, 3)
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
                      {tags.map(t => (
                        <span key={t} className="cd-minitag">{TAG_DEFS.find(d => d.key === t)?.label}</span>
                      ))}
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
              {filtered.length === 0 && leads.length > 0 && (
                <div className="cd-empty">אין לידים שמתאימים לסינון — נסו לנקות את החיפוש</div>
              )}
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
                        {formatPhone(selected.phone)}
                        {' · '}לקוח מאז {new Date(selected.created_at || Date.now()).toLocaleDateString('he-IL')}
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
                  <div className="cd-thread-head">
                    <span>השיחה האחרונה</span>
                    <div className="cd-quick-actions">
                      <button className="cd-qa cd-qa-primary" onClick={() => setComposer({ mode: 'followup', text: followUpText(selected) })}>
                        ↩ שליחת פולו-אפ
                      </button>
                      <button className="cd-qa" onClick={() => setComposer({ mode: 'free', text: '' })}>
                        ✎ הודעה חופשית
                      </button>
                      <button className="cd-qa" onClick={markHandled}>
                        ✓ סמן כטופל
                      </button>
                    </div>
                  </div>

                  {composer && (
                    <div className="cd-composer">
                      <div className="cd-composer-label">
                        {composer.mode === 'followup' ? 'הודעת פולו-אפ (ניתן לערוך לפני שליחה)' : 'הודעה חופשית ללקוח'}
                      </div>
                      <textarea
                        autoFocus
                        rows={3}
                        value={composer.text}
                        placeholder="כתבו הודעה ללקוח…"
                        onChange={e => setComposer(c => ({ ...c, text: e.target.value }))}
                      />
                      <div className="cd-composer-actions">
                        <button className="cd-qa" onClick={() => setComposer(null)}>ביטול</button>
                        <button className="cd-qa cd-qa-primary" onClick={sendComposer} disabled={!composer.text.trim()}>
                          שליחה בוואטסאפ ←
                        </button>
                      </div>
                    </div>
                  )}

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
                            {m._manual && <span className="cd-manual-tag">נשלח ידנית</span>}
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

      {toast && <div className="cd-toast">{toast}</div>}

      <footer className="cd-footer">
        הנתונים מתעדכנים אוטומטית מכל שיחה שהסוכן מנהל בוואטסאפ
      </footer>
    </div>
  )
}
