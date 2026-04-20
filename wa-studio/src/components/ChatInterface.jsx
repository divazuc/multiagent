import { useEffect, useRef, useState } from 'react'
import { SETUP_STAGES, ARCHETYPE_STAGE_PATHS } from '../lib/presets.js'

const MODE_LABELS = { setup: 'Setup', live: 'Live', learning: 'Demo' }

export default function ChatInterface({ session, messages, sending, onSend, onClear, onStartOnboarding, onActivateLive, onOpenFaq }) {
  const [input, setInput] = useState('')
  const bottomRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (!sending) inputRef.current?.focus()
  }, [sending])

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
  const isSetup = session?.session_mode === 'setup'

  const archetype = session?.draft_setup_data?.archetype
  const activePath = archetype && ARCHETYPE_STAGE_PATHS[archetype]
    ? ARCHETYPE_STAGE_PATHS[archetype].map(key => SETUP_STAGES.find(s => s.key === key)).filter(Boolean)
    : SETUP_STAGES
  const stageIndex = activePath.findIndex(s => s.key === currentStage)

  const businessName = session?.business_name || session?.session_id

  return (
    <main className="panel panel-chat">
      {/* Header */}
      <div className="panel-header chat-header">
        <div className="chat-header-left">
          {session ? (
            <>
              {session.setup_completed && <span className="badge badge-green">Done ✓</span>}
              <span className={`mode-badge mode-${session.session_mode}`}>
                {MODE_LABELS[session.session_mode] || session.session_mode}
              </span>
              <span className="chat-session-id">{businessName}</span>
            </>
          ) : (
            <span className="muted">Select a session to start testing</span>
          )}
        </div>
        <div className="chat-header-right">
          {session?.business_id && (
            <button className="btn-faq" onClick={onOpenFaq} title="Manage FAQ">FAQ ✎</button>
          )}
          {messages.length > 0 && (
            <button className="btn-icon" onClick={onClear} title="Clear chat">✕</button>
          )}
        </div>
      </div>

      {/* Stage progress bar */}
      {isSetup && stageIndex >= 0 && (
        <div className="stage-progress">
          {activePath.map((s, i) => (
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

      {/* Messages */}
      <div className="messages">
        {!session && (
          <div className="empty-chat">
            <div className="empty-icon">💬</div>
            <div>Select a session to begin</div>
            <div className="muted">Messages flow through n8n ← Claude ← DB</div>
          </div>
        )}
        {messages.map((m, i) => {
          if (m.role === 'cta' && m.type === 'onboarding') {
            return (
              <div key={i} className="message message-cta">
                <div className="cta-card">
                  <div className="cta-title">✅ Setup complete</div>
                  <div className="cta-body">Next step: review your FAQ and teach the agent about your business.</div>
                  <button className="btn-cta" onClick={onStartOnboarding}>→ Start Onboarding</button>
                </div>
              </div>
            )
          }
          if (m.role === 'cta' && m.type === 'live') {
            return (
              <div key={i} className="message message-cta">
                <div className="cta-card">
                  <div className="cta-title">🎉 Onboarding complete</div>
                  <div className="cta-body">Your agent is ready for real customer conversations.</div>
                  <button className="btn-cta" onClick={onActivateLive}>→ Go Live</button>
                </div>
              </div>
            )
          }
          return (
            <div key={i} className={`message message-${m.role}`}>
              <div className="message-bubble">{m.content}</div>
              {m.stage && <div className="message-stage">← {m.stage}</div>}
            </div>
          )
        })}

        {sending && (
          <div className="message message-assistant">
            <div className="message-bubble typing">
              <span /><span /><span />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <form className="chat-input-area" onSubmit={handleSubmit}>
        <button
          className="btn-send"
          type="submit"
          disabled={!session || sending || !input.trim()}
        >
          {sending ? '…' : '➤'}
        </button>
        <textarea
          ref={inputRef}
          className="chat-input"
          placeholder={session ? 'Type a message…' : 'No session selected'}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          disabled={!session || sending}
          rows={1}
        />
      </form>
    </main>
  )
}
