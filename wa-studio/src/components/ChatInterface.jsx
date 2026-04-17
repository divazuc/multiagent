import { useEffect, useRef, useState } from 'react'
import { SETUP_STAGES } from '../lib/presets.js'

export default function ChatInterface({ session, messages, sending, onSend, onClear }) {
  const [input, setInput] = useState('')
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  function handleSubmit(e) {
    e.preventDefault()
    if (!input.trim()) return
    onSend(input.trim())
    setInput('')
  }

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  const currentStage = session?.current_setup_stage || session?.current_stage
  const stageIndex = SETUP_STAGES.findIndex(s => s.key === currentStage)
  const isSetup = session?.session_mode === 'setup'

  return (
    <main className="panel panel-chat">
      <div className="panel-header chat-header">
        <div className="chat-header-left">
          {session ? (
            <>
              <span className="chat-session-id">{session.session_id}</span>
              <span className={`mode-badge mode-${session.session_mode}`}>
                {session.session_mode}
              </span>
              {session.setup_completed && <span className="badge badge-green">setup ✓</span>}
            </>
          ) : (
            <span className="muted">Select or create a session</span>
          )}
        </div>
        {messages.length > 0 && (
          <button className="btn-icon" onClick={onClear} title="Clear chat">✕</button>
        )}
      </div>

      {isSetup && stageIndex >= 0 && (
        <div className="stage-progress">
          {SETUP_STAGES.map((s, i) => (
            <div
              key={s.key}
              className={`stage-step ${i < stageIndex ? 'done' : i === stageIndex ? 'active' : ''}`}
              title={s.label}
            >
              <div className="stage-dot" />
              <div className="stage-label">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      <div className="messages">
        {!session && (
          <div className="empty-chat">
            <div className="empty-icon">💬</div>
            <div>Select a session to start testing</div>
            <div className="muted">Messages go through n8n → Claude → DB</div>
          </div>
        )}
        {session && messages.length === 0 && (
          <div className="empty-chat">
            <div className="empty-icon">
              {isSetup ? '🛠' : session.session_mode === 'live' ? '🤖' : '🎓'}
            </div>
            <div>
              {isSetup
                ? 'Send a message to start the business setup flow'
                : session.session_mode === 'live'
                  ? 'Send a message to test the conversation engine'
                  : 'Send a message to start the demo learning phase'}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`message message-${m.role}`}>
            <div className="message-bubble">
              {m.content}
            </div>
            {m.stage && <div className="message-stage">→ {m.stage}</div>}
          </div>
        ))}

        {sending && (
          <div className="message message-assistant">
            <div className="message-bubble typing">
              <span /><span /><span />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form className="chat-input-area" onSubmit={handleSubmit}>
        <textarea
          className="chat-input"
          placeholder={session ? 'Type a message… (Enter to send)' : 'No session selected'}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          disabled={!session || sending}
          rows={2}
        />
        <button
          className="btn btn-send"
          type="submit"
          disabled={!session || sending || !input.trim()}
        >
          {sending ? '…' : '↑'}
        </button>
      </form>
    </main>
  )
}
