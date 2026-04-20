import { useState, useEffect } from 'react'
import { loadFaqItems, updateFaqItem, deleteFaqItem, addFaqItem } from '../lib/supabase.js'
import { CATEGORIES, ARCHETYPES, ARCHETYPE_KEYS } from '../lib/faq-starters.js'

const STATUS = {
  pending:  { label: 'ממתין',   cls: 'fq-status-pending'  },
  active:   { label: 'פעיל',    cls: 'fq-status-active'   },
  inactive: { label: 'לא פעיל', cls: 'fq-status-inactive' },
}

function itemStatus(item) {
  if (!item.answer) return 'pending'
  return item.is_active ? 'active' : 'inactive'
}

function sortItems(items) {
  const order = { pending: 0, active: 1, inactive: 2 }
  return [...items].sort((a, b) => order[itemStatus(a)] - order[itemStatus(b)])
}

export default function FaqPanel({ businessId, businessName, onClose }) {
  const [items, setItems]           = useState([])
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState(null)
  const [expandedId, setExpandedId] = useState(null)
  const [editState, setEditState]   = useState({})
  const [addOpen, setAddOpen]       = useState(false)
  const [newItem, setNewItem]       = useState({ category: 'general', question: '', answer: '' })
  const [saving, setSaving]         = useState(false)

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
    setEditState(prev => ({
      ...prev,
      [item.id]: {
        question: item.question,
        answer: item.answer,
        category: item.category || 'general',
      },
    }))
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
      await updateFaqItem(item.id, {
        question: edit.question,
        answer: edit.answer,
        category: edit.category,
      })
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
      setAddOpen(false)
      await load()
    } catch (e) { setError(e.message) }
    finally { setSaving(false) }
  }

  const pending  = items.filter(i => itemStatus(i) === 'pending')
  const answered = items.filter(i => itemStatus(i) !== 'pending')

  return (
    <div className="fq-panel">
      <div className="fq-header">
        <button className="fq-back-btn" onClick={onClose} title="Back to chat">←</button>
        <div className="fq-header-title">
          <span className="fq-title">Knowledge Base</span>
          <span className="fq-subtitle" lang="he">{businessName}</span>
        </div>
        <button className="fq-add-btn" onClick={() => setAddOpen(o => !o)}>
          {addOpen ? '✕' : '+ שאלה חדשה'}
        </button>
      </div>

      {error && <div className="fq-error">{error}</div>}

      <div className="fq-list">
        {addOpen && (
          <div className="fq-add-form" lang="he">
            <div className="fq-add-row">
              <label className="fq-add-label">קטגוריה:</label>
              <select
                className="fq-select"
                value={newItem.category}
                onChange={e => setNewItem(p => ({ ...p, category: e.target.value }))}
              >
                {Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <input
              className="fq-input"
              placeholder="שאלה..."
              value={newItem.question}
              onChange={e => setNewItem(p => ({ ...p, question: e.target.value }))}
              dir="rtl"
            />
            <textarea
              className="fq-textarea"
              placeholder="תשובה (ניתן להשאיר ריק)..."
              value={newItem.answer}
              onChange={e => setNewItem(p => ({ ...p, answer: e.target.value }))}
              rows={3}
              dir="rtl"
            />
            <div className="fq-form-actions">
              <button className="fq-btn-save" onClick={handleAdd} disabled={saving || !newItem.question.trim()}>שמור</button>
              <button className="fq-btn-cancel" onClick={() => { setAddOpen(false); setNewItem({ category: 'general', question: '', answer: '' }) }}>ביטול</button>
            </div>
          </div>
        )}

        {loading && <div className="fq-state-msg">טוען...</div>}

        {!loading && items.length === 0 && !addOpen && (
          <div className="fq-state-msg" lang="he">אין שאלות עדיין — לחצו על "+ שאלה חדשה" כדי להוסיף.</div>
        )}

        {!loading && pending.length > 0 && (
          <section className="fq-section">
            <div className="fq-section-hd" lang="he">
              <span>ממתין לתשובה</span>
              <span className="fq-count">{pending.length}</span>
            </div>
            {pending.map(item => (
              <FaqRow key={item.id} item={item}
                expanded={expandedId === item.id} editing={editState[item.id]} saving={saving}
                onToggle={() => setExpandedId(expandedId === item.id ? null : item.id)}
                onEdit={() => startEdit(item)} onCancelEdit={() => cancelEdit(item.id)}
                onSave={() => saveEdit(item)} onDelete={() => handleDelete(item.id)}
                onToggleActive={() => toggleActive(item)}
                onEditChange={patch => setEditState(prev => ({ ...prev, [item.id]: { ...prev[item.id], ...patch } }))}
              />
            ))}
          </section>
        )}

        {!loading && answered.length > 0 && (
          <section className="fq-section">
            {pending.length > 0 && (
              <div className="fq-section-hd" lang="he">
                <span>שאלות קיימות</span>
                <span className="fq-count">{answered.length}</span>
              </div>
            )}
            {answered.map(item => (
              <FaqRow key={item.id} item={item}
                expanded={expandedId === item.id} editing={editState[item.id]} saving={saving}
                onToggle={() => setExpandedId(expandedId === item.id ? null : item.id)}
                onEdit={() => startEdit(item)} onCancelEdit={() => cancelEdit(item.id)}
                onSave={() => saveEdit(item)} onDelete={() => handleDelete(item.id)}
                onToggleActive={() => toggleActive(item)}
                onEditChange={patch => setEditState(prev => ({ ...prev, [item.id]: { ...prev[item.id], ...patch } }))}
              />
            ))}
          </section>
        )}
      </div>
    </div>
  )
}

function FaqRow({ item, expanded, editing, onToggle, onEdit, onCancelEdit, onSave, onDelete, onToggleActive, onEditChange, saving }) {
  const status   = itemStatus(item)
  const st       = STATUS[status]
  const catLabel = CATEGORIES[item.category] || item.category
  const archetypes = Array.isArray(item.archetypes) ? item.archetypes : []
  const archetypePills = archetypes.length === 0
    ? [{ key: 'universal', label: 'כללי', cls: 'fq-arc-universal' }]
    : archetypes
        .filter(a => ARCHETYPE_KEYS.includes(a))
        .map(a => ({ key: a, label: ARCHETYPES[a], cls: `fq-arc-${a}` }))

  return (
    <div className={`fq-row fq-row-${status}`}>
      <div className="fq-row-hd" onClick={onToggle}>
        <span className="fq-chevron">{expanded ? '▾' : '▸'}</span>
        <span className="fq-cat-badge" lang="he">{catLabel}</span>
        {archetypePills.map(p => (
          <span key={p.key} className={`fq-arc-badge ${p.cls}`} lang="he">{p.label}</span>
        ))}
        <span className="fq-q-text" lang="he" dir="rtl">{item.question || '(שאלה ריקה)'}</span>
        <span className={`fq-status-badge ${st.cls}`} lang="he">{st.label}</span>
        <span className="fq-row-btns" onClick={e => e.stopPropagation()}>
          <button className="fq-icon-btn" onClick={onEdit} title="ערוך">✏️</button>
          <button className="fq-icon-btn" onClick={onDelete} title="מחק">🗑️</button>
        </span>
      </div>

      {expanded && (
        <div className="fq-row-body" lang="he">
          {editing ? (
            <>
              <input
                className="fq-input"
                value={editing.question}
                onChange={e => onEditChange({ question: e.target.value })}
                dir="rtl"
                placeholder="שאלה"
              />
              <textarea
                className="fq-textarea"
                value={editing.answer}
                onChange={e => onEditChange({ answer: e.target.value })}
                rows={4}
                dir="rtl"
                placeholder="תשובה..."
              />
              <select
                className="fq-select"
                value={editing.category}
                onChange={e => onEditChange({ category: e.target.value })}
              >
                {Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <div className="fq-form-actions">
                <button className="fq-btn-save" onClick={onSave} disabled={saving}>שמור</button>
                <button className="fq-btn-cancel" onClick={onCancelEdit}>ביטול</button>
              </div>
            </>
          ) : (
            <>
              {item.answer
                ? <div className="fq-answer-text" dir="rtl">{item.answer}</div>
                : <div className="fq-answer-empty">אין תשובה עדיין — לחצו על ✏️ לעריכה</div>
              }
              {item.answer && (
                <label className="fq-active-label">
                  <input type="checkbox" checked={item.is_active} onChange={onToggleActive} />
                  <span>{item.is_active ? 'פעיל — בטל סימון להשבית' : 'לא פעיל — סמנו להפעלה'}</span>
                </label>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
