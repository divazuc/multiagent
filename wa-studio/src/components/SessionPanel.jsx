import { useState } from 'react'
import { PRESETS } from '../lib/presets.js'

const MODE_LABELS = { setup: 'Setup', live: 'Live', learning: 'Demo' }
const MODE_COLORS = { setup: '#f59e0b', live: '#22c55e', learning: '#818cf8' }

export default function SessionPanel({ sessions, activeSession, onSelect, onCreate, onSeed, onRefresh }) {
  const [newId, setNewId] = useState('')
  const [newMode, setNewMode] = useState('setup')
  const [creating, setCreating] = useState(false)
  const [showSeed, setShowSeed] = useState(false)

  async function handleCreate(e) {
    e.preventDefault()
    if (!newId.trim()) return
    setCreating(true)
    await onCreate(newId.trim(), newMode)
    setNewId('')
    setCreating(false)
  }

  return (
    <aside className="panel panel-sessions">
      <div className="panel-header">
        <span>Sessions</span>
        <button className="btn-icon" onClick={onRefresh} title="Refresh">↻</button>
      </div>

      <form className="new-session-form" onSubmit={handleCreate}>
        <input
          className="input"
          placeholder="session_id or phone"
          value={newId}
          onChange={e => setNewId(e.target.value)}
          spellCheck={false}
        />
        <select className="select" value={newMode} onChange={e => setNewMode(e.target.value)}>
          <option value="setup">Setup</option>
          <option value="live">Live</option>
          <option value="learning">Demo</option>
        </select>
        <button className="btn btn-primary" type="submit" disabled={creating || !newId.trim()}>
          {creating ? '…' : '+ New'}
        </button>
      </form>

      <div className="session-list">
        {sessions.length === 0 && <div className="empty-state">No sessions yet</div>}
        {sessions.map(s => (
          <div
            key={s.session_id}
            className={`session-item ${activeSession?.session_id === s.session_id ? 'active' : ''}`}
            onClick={() => onSelect(s)}
          >
            <div className="session-id">{s.session_id}</div>
            <div className="session-meta">
              <span className="badge" style={{ color: MODE_COLORS[s.session_mode] || '#888' }}>
                {MODE_LABELS[s.session_mode] || s.session_mode}
              </span>
              {s.setup_completed && <span className="badge badge-green">✓ done</span>}
              {s.current_setup_stage && !s.setup_completed && (
                <span className="badge badge-dim">{s.current_setup_stage.replace('collect_', '')}</span>
              )}
            </div>
          </div>
        ))}
      </div>

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
