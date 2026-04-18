import { useEffect, useState } from 'react'
import { PRESETS } from '../lib/presets.js'
import { listBusinesses, createBusiness } from '../lib/supabase.js'

const MODE_LABELS = { setup: 'Setup', live: 'Live', learning: 'Demo' }
const MODE_COLORS = { setup: '#f59e0b', live: '#22c55e', learning: '#818cf8' }
const STATUS_COLORS = { active: '#22c55e', inactive: '#666' }

export default function SessionPanel({ sessions, activeSession, onSelect, onCreate, onSeed, onRefresh }) {
  const [mode, setMode] = useState('setup')
  const [creating, setCreating] = useState(false)
  const [showSeed, setShowSeed] = useState(false)

  // Business picker state
  const [businesses, setBusinesses] = useState([])
  const [selectedBizId, setSelectedBizId] = useState('')
  const [bizError, setBizError] = useState(null)

  // New test business form
  const [showNewBiz, setShowNewBiz] = useState(false)
  const [newBizName, setNewBizName] = useState('')
  const [creatingBiz, setCreatingBiz] = useState(false)

  useEffect(() => {
    loadBusinesses()
  }, [])

  async function loadBusinesses() {
    try {
      const list = await listBusinesses()
      setBusinesses(list)
      setBizError(null)
    } catch (e) {
      setBizError(e.message)
    }
  }

  async function handleCreateBusiness(e) {
    e.preventDefault()
    if (!newBizName.trim()) return
    setCreatingBiz(true)
    try {
      const biz = await createBusiness({ name: newBizName.trim(), isTest: true })
      await loadBusinesses()
      setSelectedBizId(biz.id)
      setNewBizName('')
      setShowNewBiz(false)
    } catch (e) {
      setBizError(e.message)
    } finally {
      setCreatingBiz(false)
    }
  }

  async function handleStartSession(e) {
    e.preventDefault()
    if (!selectedBizId) return
    setCreating(true)
    const sessionId = `${selectedBizId.slice(0, 8)}_${Date.now()}`
    await onCreate(sessionId, mode, selectedBizId)
    setCreating(false)
  }

  const activeBiz = businesses.filter(b => b.status === 'active')
  const inactiveBiz = businesses.filter(b => b.status === 'inactive')

  return (
    <aside className="panel panel-sessions">
      <div className="panel-header">
        <span>Sessions</span>
        <button className="btn-icon" onClick={() => { onRefresh(); loadBusinesses() }} title="Refresh">↻</button>
      </div>

      {/* ── Start session form ── */}
      <form className="new-session-form" onSubmit={handleStartSession}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>Business</span>
          <button type="button" className="btn-icon" title="Add test business" onClick={() => setShowNewBiz(v => !v)}>＋</button>
        </div>

        {showNewBiz && (
          <div style={{ display: 'flex', gap: 4 }}>
            <input
              className="input"
              placeholder="Business name"
              value={newBizName}
              onChange={e => setNewBizName(e.target.value)}
              autoFocus
            />
            <button className="btn btn-primary" type="button" disabled={creatingBiz || !newBizName.trim()} onClick={handleCreateBusiness}>
              {creatingBiz ? '…' : '✓'}
            </button>
          </div>
        )}

        <select
          className="select"
          value={selectedBizId}
          onChange={e => setSelectedBizId(e.target.value)}
        >
          <option value="">— pick a business —</option>
          {activeBiz.length > 0 && (
            <optgroup label="Active">
              {activeBiz.map(b => (
                <option key={b.id} value={b.id}>
                  {b.name}{b.is_test ? ' [test]' : ''}{b.archetype ? ` · ${b.archetype}` : ''}
                </option>
              ))}
            </optgroup>
          )}
          {inactiveBiz.length > 0 && (
            <optgroup label="Inactive">
              {inactiveBiz.map(b => (
                <option key={b.id} value={b.id}>
                  {b.name}{b.is_test ? ' [test]' : ''}
                </option>
              ))}
            </optgroup>
          )}
        </select>

        {bizError && <div style={{ fontSize: 10, color: 'var(--error-text)' }}>{bizError}</div>}

        <select className="select" value={mode} onChange={e => setMode(e.target.value)}>
          <option value="setup">Setup mode</option>
          <option value="live">Live mode</option>
          <option value="learning">Demo / Learning</option>
        </select>

        <button className="btn btn-primary" type="submit" disabled={creating || !selectedBizId}>
          {creating ? '…' : '▶ Start Session'}
        </button>
      </form>

      {/* ── Session list ── */}
      <div className="session-list">
        {sessions.length === 0 && <div className="empty-state">No sessions yet</div>}
        {sessions.map(s => {
          const biz = businesses.find(b => b.id === s.business_id)
          return (
            <div
              key={s.session_id}
              className={`session-item ${activeSession?.session_id === s.session_id ? 'active' : ''}`}
              onClick={() => onSelect(s)}
            >
              <div className="session-id">{biz ? biz.name : s.session_id}</div>
              {biz && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3 }}>{s.session_id}</div>}
              <div className="session-meta">
                <span className="badge" style={{ color: MODE_COLORS[s.session_mode] || '#888' }}>
                  {MODE_LABELS[s.session_mode] || s.session_mode}
                </span>
                {s.setup_completed && <span className="badge badge-green">✓ done</span>}
                {s.current_setup_stage && !s.setup_completed && (
                  <span className="badge badge-dim">{s.current_setup_stage.replace(/^(collect_|service_|studio_|generic_)/, '')}</span>
                )}
                {biz?.is_test && <span className="badge badge-dim">test</span>}
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Seed profile ── */}
      {activeSession && (
        <div className="seed-section">
          <button className="btn btn-secondary btn-block" onClick={() => setShowSeed(!showSeed)}>
            {showSeed ? '▲ Hide' : '▼ Seed Profile'}
          </button>
          {showSeed && (
            <div className="seed-list">
              {PRESETS.map(p => (
                <button key={p.id} className="btn btn-ghost btn-block seed-item" onClick={() => { onSeed(p); setShowSeed(false) }}>
                  <span>{p.label}</span>
                  <span className="seed-hint">injects profile → live mode</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  )
}
