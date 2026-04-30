import { useEffect, useState } from 'react'
import { PRESETS } from '../lib/presets.js'
import { listBusinesses, createBusiness } from '../lib/supabase.js'

const MODE_LABELS = { setup: 'Setup', live: 'Live', learning: 'Demo' }
const MODE_COLORS = { setup: '#f59e0b', live: '#22c55e', learning: '#818cf8' }

export default function SessionPanel({ sessions, activeSession, onSelect, onCreate, onRestart, onSeed, onRefresh, className = '' }) {
  const [mode, setMode] = useState('setup')
  const [creating, setCreating] = useState(false)
  const [showSeed, setShowSeed] = useState(false)
  const [error, setError] = useState(null)
  const [conflict, setConflict] = useState(null) // existing session for selected business

  // Business list
  const [businesses, setBusinesses] = useState([])
  const [selectedBizId, setSelectedBizId] = useState('')

  // New business form
  const [newBizName, setNewBizName] = useState('')
  const [newBizSlug, setNewBizSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [creatingBiz, setCreatingBiz] = useState(false)
  const [showNewBizForm, setShowNewBizForm] = useState(false)

  useEffect(() => { loadBusinesses() }, [])

  async function loadBusinesses() {
    try {
      const list = await listBusinesses()
      setBusinesses(list)
      setError(null)
    } catch (e) {
      setError(e.message)
    }
  }

  function toSlug(str) {
    return str.toLowerCase().trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/^-+|-+$/g, '')
  }

  function handleNameChange(val) {
    setNewBizName(val)
    if (!slugEdited) setNewBizSlug(toSlug(val))
  }

  function handleSlugChange(val) {
    setNewBizSlug(toSlug(val))
    setSlugEdited(true)
  }

  async function handleCreateBusiness(e) {
    e.preventDefault()
    if (!newBizName.trim()) return
    setCreatingBiz(true)
    setError(null)
    try {
      const biz = await createBusiness({ name: newBizName.trim(), slug: newBizSlug || null, isTest: true })
      await loadBusinesses()
      setSelectedBizId(biz.id)
      setNewBizName('')
      setNewBizSlug('')
      setSlugEdited(false)
      setShowNewBizForm(false)
    } catch (e) {
      setError(e.message)
    } finally {
      setCreatingBiz(false)
    }
  }

  async function handleStartSession(e) {
    e.preventDefault()
    if (!selectedBizId) return
    const existing = sessions.find(s => s.business_id === selectedBizId)
    if (existing) {
      setConflict(existing)
      return
    }
    setCreating(true)
    setError(null)
    const sessionId = `${selectedBizId.slice(0, 8)}_${Date.now()}`
    try {
      await onCreate(sessionId, mode, selectedBizId)
    } catch (e) {
      setError(e.message)
    } finally {
      setCreating(false)
    }
  }

  function handleResume() {
    onSelect(conflict)
    setConflict(null)
  }

  async function handleRestart() {
    const existing = conflict
    setConflict(null)
    setCreating(true)
    setError(null)
    try {
      await onRestart(existing, mode, selectedBizId)
    } catch (e) {
      setError(e.message)
    } finally {
      setCreating(false)
    }
  }

  const activeBiz = businesses.filter(b => b.status === 'active')
  const inactiveBiz = businesses.filter(b => b.status === 'inactive')
  const selectedBiz = businesses.find(b => b.id === selectedBizId)

  return (
    <aside className={`panel panel-sessions ${className}`}>
      <div className="panel-header">
        <span>Sessions</span>
        <button className="btn-icon" onClick={() => { onRefresh(); loadBusinesses() }} title="Refresh">↻</button>
      </div>

      <div className="new-session-form">

        {/* ── Step 1: Business ── */}
        <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>
          1 · Business
        </div>

        {!showNewBizForm ? (
          <>
            <select
              className="select"
              value={selectedBizId}
              onChange={e => setSelectedBizId(e.target.value)}
            >
              <option value="">— select a business —</option>
              {activeBiz.map(b => (
                <option key={b.id} value={b.id}>
                  {b.name}{b.slug ? ` · #${b.slug}` : ''}{b.is_test ? ' [test]' : ''}{b.archetype ? ` · ${b.archetype}` : ''}
                </option>
              ))}
              {inactiveBiz.length > 0 && (
                <optgroup label="── Inactive ──">
                  {inactiveBiz.map(b => (
                    <option key={b.id} value={b.id}>{b.name}{b.is_test ? ' [test]' : ''}</option>
                  ))}
                </optgroup>
              )}
            </select>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setShowNewBizForm(true)}
            >
              + New Business (test)
            </button>
          </>
        ) : (
          <form onSubmit={handleCreateBusiness} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <input
              className="input"
              placeholder="Business name (e.g. TechPro IT)"
              value={newBizName}
              onChange={e => handleNameChange(e.target.value)}
              autoFocus
            />
            <div style={{ position: 'relative' }}>
              <input
                className="input"
                placeholder="slug"
                value={newBizSlug}
                onChange={e => handleSlugChange(e.target.value)}
                style={{ paddingLeft: 28, fontFamily: 'var(--font-mono)', fontSize: 11 }}
              />
              <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: 'var(--text-muted)', pointerEvents: 'none' }}>#</span>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-primary" type="submit" disabled={creatingBiz || !newBizName.trim()} style={{ flex: 1 }}>
                {creatingBiz ? '…' : 'Create'}
              </button>
              <button className="btn" type="button" onClick={() => { setShowNewBizForm(false); setNewBizName('') }}>
                Cancel
              </button>
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              A test phone number will be created automatically.
            </div>
          </form>
        )}

        {/* ── Step 2: Mode ── */}
        <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2, marginTop: 4 }}>
          2 · Mode
        </div>
        <select className="select" value={mode} onChange={e => setMode(e.target.value)}>
          <option value="setup">Setup — onboard a new business</option>
          <option value="live">Live — test conversation engine</option>
          <option value="learning">Demo — learning phase</option>
        </select>

        {/* ── Step 3: Start ── */}
        {error && <div style={{ fontSize: 10, color: 'var(--error-text)', marginTop: 2 }}>{error}</div>}

        {conflict ? (
          <div className="session-conflict">
            <div className="session-conflict-msg">
              A session already exists for <strong>{selectedBiz?.name}</strong>. Resume where you left off or restart from scratch?
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleResume}>↩ Resume</button>
              <button className="btn btn-danger" style={{ flex: 1 }} onClick={handleRestart} disabled={creating}>
                {creating ? '…' : '↺ Restart'}
              </button>
            </div>
            <button className="btn" style={{ width: '100%' }} onClick={() => setConflict(null)}>Cancel</button>
          </div>
        ) : (
          <button
            className="btn btn-primary"
            onClick={handleStartSession}
            disabled={creating || !selectedBizId || showNewBizForm}
            style={{ marginTop: 2 }}
          >
            {creating ? '…' : selectedBiz ? `▶ Start with ${selectedBiz.name}` : '▶ Start Session'}
          </button>
        )}
      </div>

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
              {biz && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.session_id}</div>}
              <div className="session-meta">
                <span className="badge" style={{ color: MODE_COLORS[s.session_mode] || '#888' }}>
                  {MODE_LABELS[s.session_mode] || s.session_mode}
                </span>
                {s.setup_completed && <span className="badge badge-green">✓</span>}
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
