import { useEffect, useState } from 'react'
import {
  fetchKnowledgeItems,
  saveKnowledgeItem,
  addKnowledgeItem,
  deleteKnowledgeItem,
} from '../lib/supabase'

const CATEGORIES = [
  { value: 'pricing',      label: 'מחירים' },
  { value: 'scheduling',   label: 'זמינות' },
  { value: 'booking',      label: 'הזמנות' },
  { value: 'services',     label: 'שירותים' },
  { value: 'location',     label: 'מיקום' },
  { value: 'cancellation', label: 'ביטולים' },
  { value: 'trial',        label: 'ניסיון' },
  { value: 'general',      label: 'כללי' },
]

const CAT_LABEL = Object.fromEntries(CATEGORIES.map(c => [c.value, c.label]))

// ── Add form ─────────────────────────────────────────────────────────────────
function AddForm({ businessId, onAdded }) {
  const [open, setOpen]   = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm]   = useState({ category: 'general', question: '', answer: '' })

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  async function handleAdd() {
    if (!form.question.trim()) return
    setSaving(true)
    const item = await addKnowledgeItem(businessId, form)
    setSaving(false)
    if (item) {
      onAdded(item)
      setForm({ category: 'general', question: '', answer: '' })
      setOpen(false)
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="section-hd" style={{ margin: 0 }}>הוספת שאלה חדשה</div>
        <button className="btn btn-ghost" style={{ padding: '6px 14px', fontSize: 12 }} onClick={() => setOpen(o => !o)}>
          {open ? '✕ סגור' : '+ הוסף שאלה'}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 6 }}>קטגוריה</div>
            <select
              className="select"
              value={form.category}
              onChange={e => set('category', e.target.value)}
            >
              {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 6 }}>שאלה</div>
            <input
              className="input"
              dir="rtl"
              placeholder="מה השאלה שלקוחות שואלים?"
              value={form.question}
              onChange={e => set('question', e.target.value)}
            />
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 6 }}>תשובה</div>
            <textarea
              className="textarea"
              dir="rtl"
              rows={3}
              placeholder="מה הסוכן יענה?"
              value={form.answer}
              onChange={e => set('answer', e.target.value)}
            />
          </div>
          <div>
            <button className="btn btn-primary" onClick={handleAdd} disabled={saving || !form.question.trim()}>
              {saving ? 'שומר...' : 'שמור שאלה'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Item row ─────────────────────────────────────────────────────────────────
function KnowledgeItem({ item, onUpdate, onDelete }) {
  const [editing, setEditing]   = useState(false)
  const [form, setForm]         = useState({ category: item.category, question: item.question, answer: item.answer })
  const [saving, setSaving]     = useState(false)
  const [toggling, setToggling] = useState(false)

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  async function handleSave() {
    setSaving(true)
    await saveKnowledgeItem(item.id, form)
    onUpdate({ ...item, ...form })
    setSaving(false)
    setEditing(false)
  }

  async function handleToggle() {
    setToggling(true)
    const next = !item.is_active
    await saveKnowledgeItem(item.id, { is_active: next })
    onUpdate({ ...item, is_active: next })
    setToggling(false)
  }

  async function handleDelete() {
    if (!window.confirm('למחוק את השאלה? פעולה זו בלתי הפיכה.')) return
    await deleteKnowledgeItem(item.id)
    onDelete(item.id)
  }

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      {!editing ? (
        /* ── View mode ── */
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)', lineHeight: 1.4, flex: 1 }} dir="rtl">
              {item.question}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <span className="status-badge" style={{
                background: item.is_active ? 'var(--accent-dim)' : 'var(--surface-2)',
                color: item.is_active ? 'var(--accent-txt)' : 'var(--text-muted)',
              }}>
                {item.is_active ? 'פעיל' : 'לא פעיל'}
              </span>
            </div>
          </div>

          <div style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.6, marginBottom: 10 }} dir="rtl">
            {item.answer
              ? (item.answer.length > 160 ? item.answer.slice(0, 160) + '…' : item.answer)
              : <span style={{ fontStyle: 'italic', color: 'var(--text-muted)' }}>אין תשובה</span>
            }
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="status-badge" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
              {CAT_LABEL[item.category] ?? item.category}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-ghost"
                style={{ padding: '5px 12px', fontSize: 12 }}
                onClick={handleToggle}
                disabled={toggling}
              >
                {item.is_active ? 'השבת' : 'הפעל'}
              </button>
              <button
                className="btn btn-ghost"
                style={{ padding: '5px 12px', fontSize: 12 }}
                onClick={() => { setForm({ category: item.category, question: item.question, answer: item.answer }); setEditing(true) }}
              >
                עריכה
              </button>
              <button
                className="btn btn-ghost"
                style={{ padding: '5px 12px', fontSize: 12, color: '#dc2626', borderColor: '#fca5a5' }}
                onClick={handleDelete}
              >
                מחק
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* ── Edit mode ── */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 700 }}>עריכת שאלה</div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 6 }}>קטגוריה</div>
            <select className="select" value={form.category} onChange={e => set('category', e.target.value)}>
              {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 6 }}>שאלה</div>
            <input className="input" dir="rtl" value={form.question} onChange={e => set('question', e.target.value)} />
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 6 }}>תשובה</div>
            <textarea className="textarea" dir="rtl" rows={4} value={form.answer} onChange={e => set('answer', e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'שומר...' : 'שמור'}
            </button>
            <button className="btn btn-ghost" onClick={() => setEditing(false)}>ביטול</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────
export default function Knowledge({ businessId }) {
  const [items, setItems]   = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!businessId) return
    fetchKnowledgeItems(businessId).then(data => {
      setItems(data)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [businessId])

  function handleAdded(item) {
    setItems(prev => [...prev, item])
  }

  function handleUpdate(updated) {
    setItems(prev => prev.map(i => i.id === updated.id ? updated : i))
  }

  function handleDelete(id) {
    setItems(prev => prev.filter(i => i.id !== id))
  }

  if (!businessId) return <div className="empty">לא נמצא עסק</div>

  const active   = items.filter(i => i.is_active).length
  const inactive = items.length - active

  return (
    <div>
      <div className="page-title">בסיס ידע / FAQ</div>

      <AddForm businessId={businessId} onAdded={handleAdded} />

      {loading ? (
        <div className="loading">טוען שאלות...</div>
      ) : items.length === 0 ? (
        <div className="empty">אין שאלות עדיין — הוסף את הראשונה למעלה</div>
      ) : (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
            {items.length} שאלות · <span style={{ color: 'var(--accent-txt)' }}>{active} פעילות</span>
            {inactive > 0 && <> · <span>{inactive} מושבתות</span></>}
          </div>
          {items.map(item => (
            <KnowledgeItem
              key={item.id}
              item={item}
              onUpdate={handleUpdate}
              onDelete={handleDelete}
            />
          ))}
        </>
      )}
    </div>
  )
}
