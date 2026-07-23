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
  const [confirmDelete, setConfirmDelete] = useState(false)

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
    setConfirmDelete(false)
    setModal({ mode: 'edit', id: item.id })
  }

  function openAdd() {
    setDraft({ category: 'general', question: '', answer: '' })
    setConfirmDelete(false)
    setModal({ mode: 'add' })
  }

  async function deleteItem() {
    if (!confirmDelete) { setConfirmDelete(true); return }
    await api.deleteFaqItem(modal.id)
    setItems(prev => prev.filter(i => i.id !== modal.id))
    setModal(null)
    showToast('השאלה נמחקה מהמאגר')
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
              {modal.mode === 'edit' && (
                <button className={`cd-qa fq-delete ${confirmDelete ? 'confirm' : ''}`} onClick={deleteItem}>
                  {confirmDelete ? 'לאשר מחיקה?' : 'מחיקה'}
                </button>
              )}
              <span className="fq-modal-spacer" />
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

// ════ Settings tab — read-only view; policy is managed by the operator ═══════

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']

function fmtRange(d) {
  if (!d?.active) return 'סגור'
  let s = (d.from || '09:00') + '–' + (d.to || '19:00')
  if (d.from2 && d.to2) s += '  ·  ' + d.from2 + '–' + d.to2
  return s
}

export function DemoSettings({ api, showToast }) {
  const [settings, setSettings] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.getBotSettings().then(s => setSettings({
      agent_active: s.agent_active !== false,
      answer_after_hours: s.answer_after_hours !== false,
      jewish_holidays: s.working_hours?.jewish_holidays !== false,
      days: Array.from({ length: 7 }, (_, i) => s.working_hours?.days?.[i] ?? { active: false }),
      after_hours_message: s.after_hours_message ?? '',
      followup_enabled: s.followup_enabled === true,
      followup_delay_days: s.followup_delay_days ?? 2,
      followup_message: s.followup_message ?? '',
      guardrails: s.guardrails ?? {},
    })).catch(() => setSettings(null))
  }, [api])

  if (!settings) return <div className="ov-empty-card ov-loading">טוען הגדרות…</div>

  const mode = !settings.agent_active ? 'off' : (settings.answer_after_hours ? 'always' : 'schedule')

  async function setMode(m) {
    const next = { agent_active: m !== 'off', answer_after_hours: m === 'always' }
    setSettings(s => ({ ...s, ...next }))
    setSaving(true)
    try {
      await api.updateBotSettings(next)
      showToast('מצב הסוכן עודכן ✓')
    } catch {
      showToast('העדכון נכשל — נסו שוב')
    } finally {
      setSaving(false)
    }
  }

  const esc = [...(settings.guardrails.escalation_points ?? [])]
  if (settings.guardrails.escalation_custom) esc.push(settings.guardrails.escalation_custom)
  const forb = [...(settings.guardrails.forbidden_topics ?? [])]
  if (settings.guardrails.forbidden_custom) forb.push(settings.guardrails.forbidden_custom)

  return (
    <div className="st-page">
      {/* master switch — the one control in the client's hands */}
      <section className="st-card">
        <h3>מצב הסוכן</h3>
        <div className="st-mode" role="radiogroup" aria-label="מצב הסוכן">
          <button className={mode === 'always' ? 'st-mode-btn on' : 'st-mode-btn'} disabled={saving} onClick={() => setMode('always')}>
            <b>פעיל תמיד</b>
            <span>עונה 24/7, מתעלם משעות הפעילות</span>
          </button>
          <button className={mode === 'schedule' ? 'st-mode-btn on' : 'st-mode-btn'} disabled={saving} onClick={() => setMode('schedule')}>
            <b>לפי שעות פעילות</b>
            <span>עונה רק בשעות שמוגדרות למטה</span>
          </button>
          <button className={mode === 'off' ? 'st-mode-btn st-mode-off on' : 'st-mode-btn st-mode-off'} disabled={saving} onClick={() => setMode('off')}>
            <b>כבוי</b>
            <span>הסוכן לא עונה כלל</span>
          </button>
        </div>
      </section>

      {/* working hours — read only */}
      <section className="st-card st-locked">
        <div className="st-locked-head">
          <h3>שעות פעילות</h3>
          <span>מנוהל על ידינו · לקריאה בלבד</span>
        </div>
        <div className="st-ro-days">
          {settings.days.map((d, i) => (
            <div key={i} className="st-ro-day">
              <span className="st-ro-name">{DAY_NAMES[i]}</span>
              <span className={d.active ? 'st-ro-range' : 'st-ro-range st-ro-closed'}>{fmtRange(d)}</span>
            </div>
          ))}
        </div>
        <div className="st-ro-line">🕎 חגי ישראל: {settings.jewish_holidays ? 'סגור (מזוהה אוטומטית)' : 'פתוח כרגיל'}</div>
        {settings.after_hours_message && (
          <div className="st-ro-line">💬 הודעה מחוץ לשעות: "{settings.after_hours_message}"</div>
        )}
      </section>

      {/* follow-up — read only */}
      <section className="st-card st-locked">
        <div className="st-locked-head">
          <h3>פולו-אפ אוטומטי</h3>
          <span>מנוהל על ידינו · לקריאה בלבד</span>
        </div>
        <div className="st-ro-line">
          {settings.followup_enabled
            ? '✅ פעיל — ליד שלא השלים תיאום מקבל פנייה חוזרת אחרי ' + settings.followup_delay_days + ' ימים'
            : '⏸ כבוי כרגע'}
        </div>
        {settings.followup_enabled && settings.followup_message && (
          <div className="st-ro-line">💬 נוסח: "{settings.followup_message}"</div>
        )}
      </section>

      {/* bot policy — read only */}
      <section className="st-card st-locked">
        <div className="st-locked-head">
          <h3>🔒 מדיניות הבוט</h3>
          <span>מנוהל על ידינו · לקריאה בלבד</span>
        </div>

        <div className="st-ro-subtitle">מתי הבוט מעביר לנציג אנושי</div>
        {esc.length > 0 ? (
          <ul className="st-rules">
            {esc.map((e, i) => <li key={i}><i>📞</i>{e}</li>)}
          </ul>
        ) : (
          <div className="st-ro-line">לפי שיקול הסוכן — בקשת נציג, תלונה או שאלה מורכבת</div>
        )}

        <div className="st-ro-subtitle">על מה הבוט לא עונה</div>
        {forb.length > 0 ? (
          <ul className="st-rules">
            {forb.map((f, i) => <li key={i}><i>🚫</i>{f}</li>)}
          </ul>
        ) : (
          <div className="st-ro-line">טרם הוגדרו נושאים חסומים ייעודיים לעסק</div>
        )}

        <div className="st-locked-note">
          ההגדרות בעמוד זה מנוהלות על ידינו כדי לשמור על עקביות ואיכות השיחות —
          כך שינוי בזרימת השיחה לעולם לא קורה בלי שנדע. לעדכון — דברו איתנו.
        </div>
      </section>
    </div>
  )
}
