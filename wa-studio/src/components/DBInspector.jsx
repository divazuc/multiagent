import { useState } from 'react'

const TABS = [
  { key: 'session',  label: 'Session' },
  { key: 'draft',    label: 'Draft' },
  { key: 'profile',  label: 'Profile' },
  { key: 'messages', label: 'Messages' },
]

function JsonView({ data }) {
  if (!data) return <div className="json-empty">—</div>
  return <pre className="json-view">{JSON.stringify(data, null, 2)}</pre>
}

function MessagesView({ messages }) {
  if (!messages?.length) return <div className="json-empty">No messages yet</div>
  return (
    <div className="db-messages">
      {messages.map((m, i) => (
        <div key={i} className="db-message-row">
          <div className="db-message-header">
            <span className="db-msg-stage">{m.stage || '—'}</span>
            <span className="db-msg-ts">{new Date(m.created_at).toLocaleTimeString()}</span>
          </div>
          {m.user_message  && <div className="db-msg-user">👤 {m.user_message}</div>}
          {m.agent_response && <div className="db-msg-agent">🤖 {m.agent_response}</div>}
        </div>
      ))}
    </div>
  )
}

export default function DBInspector({ dbState, onRefresh }) {
  const [tab, setTab] = useState('session')

  const counts = {
    session:  dbState.session  ? '1' : '0',
    draft:    dbState.draft    ? '1' : '0',
    profile:  dbState.profile  ? '1' : '0',
    messages: dbState.messages?.length || 0,
  }

  return (
    <aside className="panel panel-db">
      <div className="panel-header">
        <span>DB State</span>
        <button className="btn-icon" onClick={onRefresh} title="Refresh">↻</button>
      </div>

      <div className="db-tabs">
        {TABS.map(t => (
          <button
            key={t.key}
            className={`db-tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            <span className="tab-count">{counts[t.key]}</span>
          </button>
        ))}
      </div>

      <div className="db-content">
        {tab === 'session'  && <JsonView data={dbState.session} />}
        {tab === 'draft'    && <JsonView data={dbState.draft} />}
        {tab === 'profile'  && <JsonView data={dbState.profile} />}
        {tab === 'messages' && <MessagesView messages={dbState.messages} />}
      </div>
    </aside>
  )
}
