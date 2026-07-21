import { useState, useEffect, useCallback, Fragment } from 'react'

const AGENT_BASE = import.meta.env.VITE_AGENT_URL ?? ''
const api = (path) => AGENT_BASE ? `${AGENT_BASE}${path}` : `/api/agent${path}`

const HEALTH_COLOR = { green: '#22c55e', yellow: '#f59e0b', red: '#f87171' }
const HEALTH_ICON  = { green: '🟢', yellow: '🟡', red: '🔴' }

const STATUS_LABELS = { active: 'פעיל', inactive: 'לא פעיל', suspended: 'מושעה' }
const MODE_LABELS   = { setup: 'Setup', live: 'Live', learning: 'Demo', null: '—' }

function kv(label, value, color) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.4px' }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: color ?? 'var(--text)' }}>{value}</div>
    </div>
  )
}

export default function AdminPanel() {
  const [data, setData]       = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const [editId, setEditId]   = useState(null)
  const [editForm, setEditForm] = useState({})
  const [saving, setSaving]   = useState(false)
  const [filter, setFilter]   = useState('all') // all | red | yellow | green | test

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res  = await fetch(api('/admin/businesses'))
      const json = await res.json()
      if (json.status !== 'success') throw new Error(json.message)
      setData(json)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleDelete(biz) {
    if (!window.confirm(`למחוק את "${biz.name}" וכל הנתונים שלו לצמיתות?`)) return
    try {
      await fetch(api(`/admin/business/${biz.id}`), { method: 'DELETE' })
      await load()
    } catch (e) { setError(e.message) }
  }

  async function handleEdit(biz) {
    setEditId(biz.id)
    setEditForm({ name: biz.name, status: biz.status, archetype: biz.archetype ?? '' })
  }

  async function handleSaveEdit() {
    setSaving(true)
    try {
      await fetch(api(`/admin/business/${editId}`), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editForm),
      })
      setEditId(null)
      await load()
    } catch (e) { setError(e.message) }
    finally { setSaving(false) }
  }

  const businesses = data?.businesses ?? []
  const global     = data?.global ?? {}

  const filtered = businesses.filter(b => {
    if (filter === 'test')   return b.is_test
    if (filter === 'red')    return b.health === 'red'
    if (filter === 'yellow') return b.health === 'yellow'
    if (filter === 'green')  return b.health === 'green'
    return true
  })

  const USD_ILS = 3.7

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', background: 'var(--bg)', direction: 'rtl' }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div style={{ fontWeight: 700, fontSize: 18 }}>🛠️ Admin — כל העסקים</div>
        <button onClick={load} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 8, padding: '5px 12px', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12 }}>
          ↻ רענן
        </button>
      </div>

      {error && <div style={{ padding: 10, borderRadius: 8, background: 'var(--error-bg)', color: 'var(--error-text)', marginBottom: 16, fontSize: 12 }}>{error}</div>}

      {/* Global overview */}
      {global.total_businesses != null && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 24 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px' }}>
            {kv('עסקים', global.total_businesses)}
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              🟢 {businesses.filter(b => b.health === 'green').length} &nbsp;
              🟡 {businesses.filter(b => b.health === 'yellow').length} &nbsp;
              🔴 {businesses.filter(b => b.health === 'red').length}
            </div>
          </div>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px' }}>
            {kv('הודעות החודש', (global.ui ?? 0) + (global.bi ?? 0))}
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              {global.ui} נכנסות · {global.bi} יוצאות
            </div>
          </div>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px' }}>
            {kv('חינם נוצלו', `${Math.min(global.ui ?? 0, 1000)} / 1000`)}
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              מכסת Meta החודשית
            </div>
          </div>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderLeft: '3px solid var(--accent)', borderRadius: 12, padding: '14px 16px' }}>
            {kv('עלות Meta משוערת', global.estimated_cost_usd === 0 ? 'חינם ✓' : `₪${global.estimated_cost_ils}`, 'var(--accent)')}
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>${global.estimated_cost_usd} · {global.month}</div>
          </div>
        </div>
      )}

      {/* Filter chips */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {[
          { key: 'all',    label: `הכל (${businesses.length})` },
          { key: 'red',    label: `🔴 דורש טיפול (${businesses.filter(b => b.health === 'red').length})` },
          { key: 'yellow', label: `🟡 אזהרה (${businesses.filter(b => b.health === 'yellow').length})` },
          { key: 'green',  label: `🟢 תקין (${businesses.filter(b => b.health === 'green').length})` },
          { key: 'test',   label: `🧪 טסט (${businesses.filter(b => b.is_test).length})` },
        ].map(f => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            style={{
              padding: '5px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
              border: `1px solid ${filter === f.key ? 'var(--accent)' : 'var(--border)'}`,
              background: filter === f.key ? 'var(--accent-dim)' : 'var(--surface)',
              color: filter === f.key ? 'var(--accent)' : 'var(--text-muted)',
              cursor: 'pointer',
            }}
          >{f.label}</button>
        ))}
      </div>

      {/* Business table */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>טוען...</div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)' }}>
                {['פעולות', 'ימים ללא פעילות', 'עלות', 'הודעות', 'לידים', 'FAQ', 'דמו', 'מצב', 'סוג', 'שם עסק', ''].map((h, i) => (
                  <th key={i} style={{ textAlign: 'right', padding: '10px 12px', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.4px', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={11} style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 13 }}>אין עסקים בקטגוריה זו</td></tr>
              )}
              {filtered.map(biz => (
                <Fragment key={biz.id}>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '12px 10px', whiteSpace: 'nowrap' }}>
                      <button onClick={() => handleEdit(biz)} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', fontSize: 11, cursor: 'pointer', color: 'var(--text-muted)', marginLeft: 4 }}>✏️</button>
                      <button onClick={() => handleDelete(biz)} style={{ background: 'none', border: '1px solid #f87171', borderRadius: 6, padding: '4px 8px', fontSize: 11, cursor: 'pointer', color: '#f87171' }}>🗑️</button>
                    </td>
                    <td style={{ padding: '12px 10px', fontSize: 12, color: biz.days_inactive > 7 ? '#f87171' : 'var(--text-muted)' }}>
                      {biz.days_inactive >= 999 ? '—' : `${biz.days_inactive}d`}
                    </td>
                    <td style={{ padding: '12px 10px', fontSize: 12, color: biz.billing_month.estimated_cost_usd > 0 ? 'var(--text)' : 'var(--text-muted)' }}>
                      {biz.billing_month.estimated_cost_usd > 0 ? `$${biz.billing_month.estimated_cost_usd}` : 'חינם'}
                    </td>
                    <td style={{ padding: '12px 10px', fontSize: 12 }}>
                      <span>{biz.billing_month.ui + biz.billing_month.bi}</span>
                      <span style={{ color: 'var(--text-muted)', fontSize: 10, display: 'block' }}>{biz.billing_month.ui}↓ {biz.billing_month.bi}↑</span>
                    </td>
                    <td style={{ padding: '12px 10px', fontSize: 13 }}>{biz.total_leads}</td>
                    <td style={{ padding: '12px 10px', fontSize: 13, color: biz.active_faq === 0 ? 'var(--text-muted)' : 'var(--text)' }}>{biz.active_faq}</td>
                    <td style={{ padding: '12px 10px', fontSize: 13 }}>{biz.has_demo ? '✅' : '—'}</td>
                    <td style={{ padding: '12px 10px' }}>
                      <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 10, background: biz.session_mode === 'live' ? '#00a88420' : '#f59e0b20', color: biz.session_mode === 'live' ? 'var(--accent)' : '#d97706' }}>
                        {MODE_LABELS[biz.session_mode] ?? '—'}
                      </span>
                    </td>
                    <td style={{ padding: '12px 10px', fontSize: 12, color: 'var(--text-muted)' }}>{biz.archetype ?? '—'}</td>
                    <td style={{ padding: '12px 10px' }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{biz.name}</div>
                      {biz.is_test && <span style={{ fontSize: 10, background: '#f59e0b22', color: '#d97706', padding: '1px 6px', borderRadius: 10, fontWeight: 600 }}>test</span>}
                    </td>
                    <td style={{ padding: '12px 10px', fontSize: 16 }}>{HEALTH_ICON[biz.health]}</td>
                  </tr>

                  {/* Edit row */}
                  {editId === biz.id && (
                    <tr key={`${biz.id}-edit`} style={{ background: 'var(--surface-2)' }}>
                      <td colSpan={11} style={{ padding: '14px 16px' }}>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                          <div>
                            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3 }}>שם</div>
                            <input value={editForm.name} onChange={e => setEditForm(p => ({ ...p, name: e.target.value }))}
                              style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13 }} />
                          </div>
                          <div>
                            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3 }}>סטטוס</div>
                            <select value={editForm.status} onChange={e => setEditForm(p => ({ ...p, status: e.target.value }))}
                              style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13 }}>
                              <option value="active">פעיל</option>
                              <option value="inactive">לא פעיל</option>
                              <option value="suspended">מושעה</option>
                            </select>
                          </div>
                          <div>
                            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3 }}>ארכיטייפ</div>
                            <select value={editForm.archetype} onChange={e => setEditForm(p => ({ ...p, archetype: e.target.value }))}
                              style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13 }}>
                              <option value="">—</option>
                              <option value="service">Service</option>
                              <option value="product">Product</option>
                              <option value="booking">Booking</option>
                            </select>
                          </div>
                          <div style={{ display: 'flex', gap: 6, marginTop: 16 }}>
                            <button onClick={handleSaveEdit} disabled={saving} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                              {saving ? '...' : 'שמור'}
                            </button>
                            <button onClick={() => setEditId(null)} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 12px', fontSize: 12, cursor: 'pointer', color: 'var(--text-muted)' }}>
                              ביטול
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-muted)' }}>
        * עלויות Meta משוערות — החשבון המדויק ב-Meta Business Manager. תעריפים: UI $0.015 (אחרי 1,000 חינם), BI $0.055.
      </div>
    </div>
  )
}
