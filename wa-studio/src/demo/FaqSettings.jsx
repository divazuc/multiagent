import { useState, useEffect } from 'react'

const CATEGORY_LABELS = {
  general: 'כללי', services: 'טיפולים', pricing: 'מחירים', booking: 'תיאום',
  scheduling: 'שעות', location: 'הגעה', trial: 'התנסות', safety: 'בטיחות',
}

// ════ FAQ tab — the shared knowledge_items entity, client-editable ═══════════

export function DemoFaq({ api, showToast }) {
  const [items, setItems] = useState(null)
  // modal: null | {mode:'add'} | {mode:'edit', id}
  const [modal, setModal] = useState(null)
  const [draft, setDraft] = useState({ category: 'general', question: '', answer: '' })

  useEffect(() => {
    api.loadFaqItems().then(setItems).catch(() => setItems([]))
  }, [api])

  if (!items) return <div className="ov-empty-card ov-loading">טוען שאלות ותשובות…</div>

  const suggested = items.filter(i => i.suggested && !i.is_active)
  const active = items.filter(i => !i.suggested)

  async function approve(item) {
    await api.updateFaqItem(item.id, { suggested: false, is_active: true })
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, suggested: false, is_active: true } : i))
    showToast('השאלה נוספה למאגר — הסוכן יתחיל לענות איתה מיד ✓')
  }

  async function dismiss(item) {
    await api.updateFaqItem(item.id, { suggested: false, is_active: false })
    setItems(prev => prev.filter(i => i.id !== item.id))
    showToast('ההצעה נדחתה')
  }

  function openEdit(item) {
    setDraft({ category: item.category || 'general', question: item.question, answer: item.answer })
    setModal({ mode: 'edit', id: item.id })
  }

  function openAdd() {
    setDraft({ category: 'general', question: '', answer: '' })
    setModal({ mode: 'add' })
  }

  async function saveModal() {
    if (!draft.question.trim() || !draft.answer.trim()) return
    if (modal.mode === 'edit') {
      await api.updateFaqItem(modal.id, { category: draft.category, question: draft.question, answer: draft.answer })
      setItems(prev => prev.map(i => i.id === modal.id ? { ...i, ...draft } : i))
      showToast('השינויים נשמרו ✓')
    } else {
      const row = await api.addFaqItem(draft)
      setItems(prev => [...prev, { ...draft, id: row?.id ?? Math.random(), is_active: true, suggested: false }])
      showToast('השאלה נוספה למאגר ✓')
    }
    setModal(null)
  }

  async function toggleActive(item) {
    await api.updateFaqItem(item.id, { is_active: !item.is_active })
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, is_active: !i.is_active } : i))
  }

  return (
    <div className="fq-page">
      {suggested.length > 0 && (
        <section className="fq-suggested">
          <div className="fq-sug-head">
            <h3>💡 שאלות שחוזרות בשיחות</h3>
            <span>הסוכן זיהה שאלות שנשאלות שוב ושוב — אישור אחד והן נכנסות למאגר</span>
          </div>
          {suggested.map(item => (
            <div key={item.id} className="fq-sug-card">
              <div className="fq-sug-q">{item.question}</div>
              <div className="fq-sug-a">{item.answer}</div>
              <div className="fq-sug-actions">
                <button className="cd-qa cd-qa-primary" onClick={() => approve(item)}>✓ אישור והוספה למאגר</button>
                <button className="cd-qa" onClick={() => dismiss(item)}>דחייה</button>
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="fq-list-card">
        <div className="fq-list-head">
          <h3>מאגר השאלות והתשובות</h3>
          <span className="fq-count">{active.filter(i => i.is_active).length} שאלות פעילות</span>
          <button className="cd-qa cd-qa-primary" style={{ marginInlineStart: 'auto' }} onClick={openAdd}>
            + שאלה חדשה
          </button>
        </div>

        {active.map(item => (
          <div key={item.id} className={`fq-item ${!item.is_active ? 'fq-off' : ''}`}>
            <div className="fq-item-top">
              <span className="fq-cat">{CATEGORY_LABELS[item.category] || item.category}</span>
              <div className="fq-item-tools">
                <button className="fq-tool" onClick={() => openEdit(item)}>עריכה</button>
                <label className="fq-switch">
                  <input type="checkbox" checked={item.is_active} onChange={() => toggleActive(item)} />
                  <i />
                </label>
              </div>
            </div>
            <div className="fq-q">{item.question}</div>
            <div className="fq-a">{item.answer}</div>
          </div>
        ))}
      </section>

      {modal && (
        <div className="fq-modal-overlay" onClick={() => setModal(null)}>
          <div className="fq-modal" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
            <h3>{modal.mode === 'edit' ? 'עריכת שאלה ותשובה' : 'שאלה חדשה'}</h3>
            <label className="fq-modal-label">קטגוריה</label>
            <select value={draft.category} onChange={e => setDraft(d => ({ ...d, category: e.target.value }))}>
              {!(draft.category in CATEGORY_LABELS) && <option value={draft.category}>{draft.category}</option>}
              {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <label className="fq-modal-label">השאלה</label>
            <input
              autoFocus={modal.mode === 'add'}
              placeholder="כפי שלקוחות שואלים אותה"
              value={draft.question}
              onChange={e => setDraft(d => ({ ...d, question: e.target.value }))}
            />
            <label className="fq-modal-label">התשובה שהסוכן ייתן</label>
            <textarea
              rows={7}
              placeholder="התשובה בסגנון ובטון של העסק"
              value={draft.answer}
              onChange={e => setDraft(d => ({ ...d, answer: e.target.value }))}
            />
            <div className="fq-modal-actions">
              <button className="cd-qa" onClick={() => setModal(null)}>ביטול</button>
              <button className="cd-qa cd-qa-primary" onClick={saveModal} disabled={!draft.question.trim() || !draft.answer.trim()}>
                שמירה
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ════ Settings tab — schedule, master switch, read-only boundaries ═══════════

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']

const BOUNDARIES = [
  { icon: '💰', text: 'לא מוסר מחירים, הנחות, מבצעים או תנאי תשלום — כל שאלת מחיר עוברת לנציגה אנושית שחוזרת טלפונית' },
  { icon: '🩺', text: 'לא נותן ייעוץ רפואי אישי — הריון, הנקה, תרופות ומצבים רפואיים מופנים תמיד לרופא' },
  { icon: '🤝', text: 'לא מתחייב לתוצאות טיפול, לזמינות תור או לתנאים מסחריים' },
  { icon: '📷', text: 'לא שולח תמונות לפני/אחרי בצ׳אט — הצגה רק בפגישת ייעוץ, מטעמי פרטיות מטופלים' },
  { icon: '🔐', text: 'לא אוסף מידע רפואי רגיש מעבר לנדרש לתיאום הפגישה' },
  { icon: '📞', text: 'תלונה, לקוח כועס או בקשה לנציג — העברה מיידית לגורם אנושי ועצירת השיחה' },
]

const DEFAULT_DAY = { active: false, from: '09:00', to: '19:00' }

export function DemoSettings({ api, showToast }) {
  const [settings, setSettings] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.getBotSettings().then(s => {
      const days = Array.from({ length: 7 }, (_, i) => ({ ...DEFAULT_DAY, ...(s.working_hours?.days?.[i] ?? {}) }))
      setSettings({
        agent_active: s.agent_active !== false,
        answer_after_hours: s.answer_after_hours !== false,
        jewish_holidays: s.working_hours?.jewish_holidays !== false,
        days,
      })
    }).catch(() => setSettings(null))
  }, [api])

  if (!settings) return <div className="ov-empty-card ov-loading">טוען הגדרות…</div>

  const mode = !settings.agent_active ? 'off' : (settings.answer_after_hours ? 'always' : 'schedule')

  function setMode(m) {
    setSettings(s => ({
      ...s,
      agent_active: m !== 'off',
      answer_after_hours: m === 'always',
    }))
  }

  function setDay(i, patch) {
    setSettings(s => ({ ...s, days: s.days.map((d, j) => j === i ? { ...d, ...patch } : d) }))
  }

  async function save() {
    setSaving(true)
    try {
      const working_hours = {
        jewish_holidays: settings.jewish_holidays,
        days: settings.days.map(d => {
          const out = { active: d.active, from: d.from, to: d.to }
          if (d.from2 && d.to2) { out.from2 = d.from2; out.to2 = d.to2 }
          return out
        }),
      }
      await api.updateBotSettings({
        working_hours,
        agent_active: settings.agent_active,
        answer_after_hours: settings.answer_after_hours,
      })
      showToast('ההגדרות נשמרו — נכנסות לתוקף מיד ✓')
    } catch {
      showToast('שמירת ההגדרות נכשלה — נסו שוב')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="st-page">
      {/* master switch */}
      <section className="st-card">
        <h3>מצב הסוכן</h3>
        <div className="st-mode" role="radiogroup" aria-label="מצב הסוכן">
          <button className={`st-mode-btn ${mode === 'always' ? 'on' : ''}`} onClick={() => setMode('always')}>
            <b>פעיל תמיד</b>
            <span>עונה 24/7, מתעלם משעות הפעילות</span>
          </button>
          <button className={`st-mode-btn ${mode === 'schedule' ? 'on' : ''}`} onClick={() => setMode('schedule')}>
            <b>לפי שעות פעילות</b>
            <span>עונה רק בשעות שמוגדרות למטה</span>
          </button>
          <button className={`st-mode-btn st-mode-off ${mode === 'off' ? 'on' : ''}`} onClick={() => setMode('off')}>
            <b>כבוי</b>
            <span>הסוכן לא עונה כלל</span>
          </button>
        </div>
      </section>

      {/* schedule */}
      <section className={`st-card ${mode !== 'schedule' ? 'st-muted' : ''}`}>
        <div className="st-sched-head">
          <h3>שעות פעילות</h3>
          {mode === 'always' && <span className="st-note">הסוכן במצב "פעיל תמיד" — השעות שמורות אך לא פעילות</span>}
          {mode === 'off' && <span className="st-note">הסוכן כבוי — השעות שמורות אך לא פעילות</span>}
        </div>
        <div className="st-days">
          {settings.days.map((d, i) => (
            <div key={i} className={`st-day ${!d.active ? 'st-day-off' : ''}`}>
              <label className="st-day-name">
                <input type="checkbox" checked={d.active} onChange={e => setDay(i, { active: e.target.checked })} />
                {DAY_NAMES[i]}
              </label>
              {d.active ? (
                <div className="st-ranges">
                  <span className="st-range">
                    <input type="time" value={d.from} onChange={e => setDay(i, { from: e.target.value })} />
                    –
                    <input type="time" value={d.to} onChange={e => setDay(i, { to: e.target.value })} />
                  </span>
                  {d.from2 !== undefined ? (
                    <span className="st-range">
                      <input type="time" value={d.from2 || '16:00'} onChange={e => setDay(i, { from2: e.target.value })} />
                      –
                      <input type="time" value={d.to2 || '19:00'} onChange={e => setDay(i, { to2: e.target.value })} />
                      <button className="st-range-x" title="הסרת טווח" onClick={() => setDay(i, { from2: undefined, to2: undefined })}>✕</button>
                    </span>
                  ) : (
                    <button className="st-add-range" onClick={() => setDay(i, { from2: '16:00', to2: '19:00' })}>+ טווח נוסף</button>
                  )}
                </div>
              ) : (
                <span className="st-closed">סגור</span>
              )}
            </div>
          ))}
        </div>
        <label className="st-holidays">
          <input type="checkbox" checked={settings.jewish_holidays} onChange={e => setSettings(s => ({ ...s, jewish_holidays: e.target.checked }))} />
          סגור בחגי ישראל (הסוכן מזהה את מועדי החגים אוטומטית)
        </label>
      </section>

      <button className="st-save" onClick={save} disabled={saving}>
        {saving ? 'שומר…' : 'שמירת הגדרות'}
      </button>

      {/* read-only boundaries */}
      <section className="st-card st-locked">
        <div className="st-locked-head">
          <h3>🔒 גבולות הסוכן</h3>
          <span>מוגדר ברמת המערכת · לקריאה בלבד</span>
        </div>
        <ul className="st-rules">
          {BOUNDARIES.map((b, i) => (
            <li key={i}><i>{b.icon}</i>{b.text}</li>
          ))}
        </ul>
        <div className="st-locked-note">
          הכללים האלה נאכפים בכל שיחה, בכל שעה, בלי תלות בהגדרות שלמעלה — ואינם ניתנים לשינוי מהדשבורד.
          לעדכון גבולות הסוכן פנו אלינו.
        </div>
      </section>
    </div>
  )
}
