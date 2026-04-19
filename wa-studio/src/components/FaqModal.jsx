import { useState, useEffect } from 'react'
import { loadFaqItems, updateFaqItem, deleteFaqItem, addFaqItem } from '../lib/supabase.js'
import { CATEGORIES } from '../lib/faq-starters.js'

const STATUS = {
  pending:  { label: 'ממתין',    cls: 'faq-status-pending'  },
  active:   { label: 'פעיל',     cls: 'faq-status-active'   },
  inactive: { label: 'לא פעיל',  cls: 'faq-status-inactive' },
}

function itemStatus(item) {
  if (!item.answer) return 'pending'
  return item.is_active ? 'active' : 'inactive'
}

function sortItems(items) {
  const order = { pending: 0, active: 1, inactive: 2 }
  return [...items].sort((a, b) => order[itemStatus(a)] - order[itemStatus(b)])
}

export default function FaqModal({ businessId, businessName, onClose }) {
  const [items, setItems]         = useState([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(null)
  const [expandedId, setExpandedId] = useState(null)
  const [editState, setEditState] = useState({})
  const [addMode, setAddMode]     = useState(false)
  const [newItem, setNewItem]     = useState({ category: 'general', question: '', answer: '' })
  const [saving, setSaving]       = useState(false)

  useEffect(() => { load() }, [businessId])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const data = await loadFaqItems(businessId)
      setItems(sortItems(data))
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  function startEdit(item) {
    setEditState(prev => ({ ...prev, [item.id]: { question: item.question, answer: item.answer, category: item.category || 'general' } }))
    setExpandedId(item.id)
  }

  function cancelEdit(id) {
    setEditState(prev => { const n = { ...prev }; delete n[id]; return n })
  }

  async function saveEdit(item) {
    const edit = editState[item.id]
    if (!edit) return
    setSaving(true)
    try {
      await updateFaqItem(item.id, { question: edit.question, answer: edit.answer, category: edit.category })
      cancelEdit(item.id)
      await load()
    } catch (e) { setError(e.message) }
    finally { setSaving(false) }
  }

  async function toggleActive(item) {
    try {
      await updateFaqItem(item.id, { is_active: !item.is_active })
      await load()
    } catch (e) { setError(e.message) }
  }

  async function handleDelete(id) {
    if (!window.confirm('למחוק שאלה זו?')) return
    try {
      await deleteFaqItem(id)
      if (expandedId === id) setExpandedId(null)
      await load()
    } catch (e) { setError(e.message) }
  }

  async function handleAdd() {
    if (!newItem.question.trim()) return
    setSaving(true)
    try {
      await addFaqItem(businessId, newItem)
      setNewItem({ category: 'general', question: '', answer: '' })
      setAddMode(false)
      await load()
    } catch (e) { setError(e.message) }
    finally { setSaving(false) }
  }

  const pending = items.filter(i => itemStatus(i) === 'pending')
  const rest    = items.filter(i => itemStatus(i) !== 'pending')

  return (
    <div className="faq-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="faq-modal">
        <div className="faq-modal-header">
          <div className="faq-modal-title">FAQ <span className="faq-biz-name">{businessName}</span></div>
          <div className="faq-modal-actions">
            <button className="btn-add-faq" onClick={() => { setAddMode(true); setExpandedId(null) }}>+ הוסף שאלה</button>
            <button className="btn-icon" onClick={onClose}>✕</button>
          </div>
        </div>

        {error && <div className="faq-error">{error}</div>}

        <div className="faq-modal-body">
          {loading && <div className="faq-loading">טוען...</div>}

          {addMode && (
            <div className="faq-add-form" dir="rtl">
              <div className="faq-add-row">
                <label className="faq-add-label">קטגוריה</label>
                <select className="faq-cat-select" value={newItem.category} onChange={e => setNewItem(p => ({ ...p, category: e.target.value }))}>
                  {Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <input className="faq-input" placeholder="שאלה..." value={newItem.question} onChange={e => setNewItem(p => ({ ...p, question: e.target.value }))} dir="rtl" />
              <textarea className="faq-textarea" placeholder="תשובה (ניתן להשאיר ריק בינתיים)..." value={newItem.answer} onChange={e => setNewItem(p => ({ ...p, answer: e.target.value }))} rows={3} dir="rtl" />
              <div className="faq-edit-buttons">
                <button className="btn-save-faq" onClick={handleAdd} disabled={saving || !newItem.question.trim()}>שמור</button>
                <button className="btn-cancel-faq" onClick={() => { setAddMode(false); setNewItem({ category: 'general', question: '', answer: '' }) }}>ביטול</button>
              </div>
            </div>
          )}

          {!loading && pending.length > 0 && (
            <div className="faq-section">
              <div className="faq-section-label">ממתין לתשובה · {pending.length}</div>
              {pending.map(item => (
                <FaqItem key={item.id} item={item} expanded={expandedId === item.id} editing={editState[item.id]}
                  onToggle={() => setExpandedId(expandedId === item.id ? null : item.id)}
                  onEdit={() => startEdit(item)} onCancelEdit={() => cancelEdit(item.id)}
                  onSave={() => saveEdit(item)} onDelete={() => handleDelete(item.id)}
                  onToggleActive={() => toggleActive(item)}
                  onEditChange={patch => setEditState(prev => ({ ...prev, [item.id]: { ...prev[item.id], ...patch } }))}
                  saving={saving} />
              ))}
            </div>
          )}

          {!loading && rest.length > 0 && (
            <div className="faq-section">
              {pending.length > 0 && <div className="faq-section-label">שאלות קיימות · {rest.length}</div>}
              {rest.map(item => (
                <FaqItem key={item.id} item={item} expanded={expandedId === item.id} editing={editState[item.id]}
                  onToggle={() => setExpandedId(expandedId === item.id ? null : item.id)}
                  onEdit={() => startEdit(item)} onCancelEdit={() => cancelEdit(item.id)}
                  onSave={() => saveEdit(item)} onDelete={() => handleDelete(item.id)}
                  onToggleActive={() => toggleActive(item)}
                  onEditChange={patch => setEditState(prev => ({ ...prev, [item.id]: { ...prev[item.id], ...patch } }))}
                  saving={saving} />
              ))}
            </div>
          )}

          {!loading && items.length === 0 && !addMode && (
            <div className="faq-empty">אין שאלות עדיין. לחצו על + הוסף שאלה.</div>
          )}
        </div>
      </div>
    </div>
  )
}

function FaqItem({ item, expanded, editing, onToggle, onEdit, onCancelEdit, onSave, onDelete, onToggleActive, onEditChange, saving }) {
  const status   = itemStatus(item)
  const st       = STATUS[status]
  const catLabel = CATEGORIES[item.category] || item.category

  return (
    <div className={`faq-item faq-item-${status}`}>
      <div className="faq-item-header" dir="rtl" onClick={onToggle}>
        <span className="faq-toggle">{expanded ? '▲' : '▼'}</span>
        <span className="faq-cat-badge">{catLabel}</span>
        <span className="faq-question">{item.question}</span>
        <span className={`faq-status-badge ${st.cls}`}>{st.label}</span>
        <div className="faq-item-actions" onClick={e => e.stopPropagation()}>
          <button className="faq-action-btn" onClick={onEdit} title="ערוך">✏️</button>
          <button className="faq-action-btn" onClick={onDelete} title="מחק">🗑️</button>
        </div>
      </div>

      {expanded && (
        <div className="faq-item-body" dir="rtl">
          {editing ? (
            <>
              <input className="faq-input" value={editing.question} onChange={e => onEditChange({ question: e.target.value })} dir="rtl" placeholder="שאלה" />
              <textarea className="faq-textarea" value={editing.answer} onChange={e => onEditChange({ answer: e.target.value })} rows={3} dir="rtl" placeholder="תשובה..." />
              <select className="faq-cat-select" value={editing.category} onChange={e => onEditChange({ category: e.target.value })}>
                {Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <div className="faq-edit-buttons">
                <button className="btn-save-faq" onClick={onSave} disabled={saving}>שמור</button>
                <button className="btn-cancel-faq" onClick={onCancelEdit}>ביטול</button>
              </div>
            </>
          ) : (
            <>
              {item.answer
                ? <div className="faq-answer-text">{item.answer}</div>
                : <div className="faq-answer-empty">אין תשובה עדיין — לחצו על ✏️ לעריכה</div>
              }
              {item.answer && (
                <label className="faq-active-toggle">
                  <input type="checkbox" checked={item.is_active} onChange={onToggleActive} />
                  {item.is_active ? 'פעיל' : 'לא פעיל — סמנו להפעלה'}
                </label>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
