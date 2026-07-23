import { useState, useEffect, useRef } from 'react'
import { logError } from './ErrorBoundary.jsx'

const AGENT_BASE = import.meta.env.VITE_AGENT_URL ?? ''
const API = (path) => AGENT_BASE ? `${AGENT_BASE}${path}` : `/api/agent${path}`

const CATEGORY_ICONS = {
  'הקול שלך / Your voice': '🎙️',
  'שאלות נפוצות / FAQ': '❓',
  'התנגדויות / Objections': '🛡️',
  'סגירה / CTA': '🎯',
  'דוגמת שיחה / Sample': '💬',
}

const MIN_QUESTIONS = 3

export default function DemoWizard({ session, onCompleted, onSkipToLive, onActivate }) {
  const [messages, setMessages] = useState([])
  const [input, setInput]       = useState('')
  const [sending, setSending]   = useState(false)
  const [progress, setProgress] = useState({ current: 0, total: 12 })
  const [done, setDone]         = useState(false)
  const [voiceProfile, setVoice] = useState(null)
  const bottomRef = useRef(null)
  const inputRef  = useRef(null)

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  useEffect(() => { if (!sending && !done) inputRef.current?.focus() }, [sending, done])

  // Auto-start on mount
  useEffect(() => {
    if (session?.session_id) startDemo()
  }, [session?.session_id])

  async function startDemo() {
    setSending(true)
    try {
      const res = await fetch(API('/wa-inbound'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'start', session_id: session.session_id, business_id: session.business_id }),
      })
      const data = await res.json()
      if (data.message) {
        setMessages([
          { role: 'intro', content: `👋 ברוכים הבאים לשלב הלמידה!\n\nאני אשאל אותך ${data.result?.total_questions ?? 12} שאלות קצרות שיעזרו לי ללמוד את הקול שלך.\n\nענה בצורה חופשית וטבעית — ממש כמו שהיית כותב ללקוח אמיתי.` },
          { role: 'assistant', content: data.message, questionIndex: data.result?.next_question_index },
        ])
        setProgress({ current: 0, total: data.result?.total_questions ?? 12 })
      }
    } catch (e) { logError(e.message, 'demo/start', e.stack) }
    finally { setSending(false) }
  }

  async function handleSend() {
    if (!input.trim() || sending) return
    const answer = input.trim()
    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: answer }])
    setSending(true)

    try {
      const res = await fetch(API('/wa-inbound'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: answer, session_id: session.session_id, business_id: session.business_id }),
      })
      const data = await res.json()
      const result = data.result ?? {}

      setMessages(prev => [...prev, { role: 'assistant', content: data.message, isDone: result.is_done }])
      setProgress({ current: result.next_question_index ?? progress.current, total: result.total_questions ?? 12 })

      if (result.is_done) {
        setDone(true)
        setVoice(result.voice_profile)
        onCompleted?.()
      }
    } catch (e) {
      logError(e.message, 'demo/send', e.stack)
      setMessages(prev => [...prev, { role: 'error', content: e.message }])
    } finally {
      setSending(false)
    }
  }

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  const pct = progress.total > 0 ? Math.round((Math.max(0, progress.current - 1) / progress.total) * 100) : 0

  return (
    <div className="panel panel-chat" style={{ display:'flex', flexDirection:'column', flex:1, overflow:'hidden' }}>

      {/* Header */}
      <div className="panel-header" style={{ flexDirection:'column', alignItems:'stretch', gap:8, padding:'12px 16px' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <span style={{ fontWeight:700, fontSize:13 }}>
            🎙️ שלב למידה — {session?.business_name || session?.session_id}
          </span>
          <span style={{ fontSize:11, color:'var(--text-muted)' }}>
            {progress.current > 0 ? `${progress.current} / ${progress.total}` : `0 / ${progress.total}`}
          </span>
        </div>
        <div style={{ height:3, background:'var(--surface-3)', borderRadius:2 }}>
          <div style={{ height:'100%', width:`${pct}%`, background:'var(--accent)', borderRadius:2, transition:'width 0.4s ease' }} />
        </div>
        <div style={{ fontSize:11, color:'var(--text-muted)' }}>
          ענה על השאלות בסגנון הטבעי שלך — הסוכן ילמד לדבר כמוך
        </div>
      </div>

      {/* Messages */}
      <div className="messages" style={{ flex:1, overflowY:'auto', padding:'16px' }}>
        {messages.map((m, i) => {
          if (m.role === 'intro') return (
            <div key={i} style={{ background:'var(--accent-dim)', border:'1px solid var(--accent)', borderRadius:10, padding:'14px 16px', marginBottom:16, fontSize:13, lineHeight:1.7, whiteSpace:'pre-line' }}>
              {m.content}
            </div>
          )
          if (m.role === 'error') return (
            <div key={i} style={{ background:'var(--error-bg)', color:'var(--error-text)', borderRadius:8, padding:'10px 14px', fontSize:12, margin:'8px 0' }}>
              {m.content}
            </div>
          )
          if (m.isDone) return (
            <div key={i} style={{ background:'var(--accent-dim)', border:'1px solid var(--accent)', borderRadius:10, padding:'16px', marginTop:16 }}>
              <div style={{ fontSize:15, fontWeight:700, color:'var(--accent)', marginBottom:8 }}>🎉 הסוכן מוכן!</div>
              <div style={{ fontSize:13, lineHeight:1.7, whiteSpace:'pre-line' }}>{m.content}</div>
              {voiceProfile && (
                <div style={{ marginTop:12, padding:12, background:'var(--surface)', borderRadius:8, fontSize:12 }}>
                  <div style={{ fontWeight:600, marginBottom:6, color:'var(--text-muted)', textTransform:'uppercase', fontSize:10 }}>פרופיל קול שחולץ</div>
                  {voiceProfile.voice_summary && <div style={{ marginBottom:4 }}>📝 {voiceProfile.voice_summary}</div>}
                  {voiceProfile.tone?.length > 0 && <div style={{ color:'var(--text-muted)' }}>טון: {voiceProfile.tone.join(', ')}</div>}
                  {voiceProfile.emoji_style && <div style={{ color:'var(--text-muted)' }}>אימוג\'י: {voiceProfile.emoji_style}</div>}
                </div>
              )}
              {onActivate && (
                <button
                  onClick={onActivate}
                  style={{
                    width:'100%', marginTop:14, padding:'13px',
                    borderRadius:10, border:'none', cursor:'pointer',
                    background:'var(--accent)', color:'#fff',
                    fontSize:14, fontWeight:800, fontFamily:'inherit',
                  }}
                >
                  🚀 להפעלת הבוט שלכם
                </button>
              )}
              {onActivate && (
                <div style={{ marginTop:6, fontSize:11, color:'var(--text-muted)', textAlign:'center' }}>
                  הבוט ייכנס לעבודה ויתחיל לענות ללקוחות בקול שלמד
                </div>
              )}
            </div>
          )
          return (
            <div key={i} className={`message message-${m.role}`}>
              <div className="message-bubble" style={{ whiteSpace:'pre-line' }}>{m.content}</div>
            </div>
          )
        })}
        {sending && (
          <div className="message message-assistant">
            <div className="message-bubble typing"><span /><span /><span /></div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Early exit — go live after MIN_QUESTIONS */}
      {!done && progress.current >= MIN_QUESTIONS && onSkipToLive && (
        <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border)', background: 'var(--surface-2)' }}>
          <button
            onClick={onSkipToLive}
            style={{ width: '100%', padding: '8px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}
          >
            מספיק לי — עבור ללייב עכשיו ({progress.current}/{progress.total} שאלות הושלמו)
          </button>
        </div>
      )}

      {/* Input */}
      {!done && (
        <form className="chat-input-area" onSubmit={e => { e.preventDefault(); handleSend() }}>
          <button className="btn-send" type="submit" disabled={sending || !input.trim()}>
            {sending ? '…' : '➤'}
          </button>
          <textarea
            ref={inputRef}
            className="chat-input"
            placeholder="כתוב את תשובתך כאן..."
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            disabled={sending}
            rows={2}
            dir="rtl"
          />
        </form>
      )}
    </div>
  )
}
