import { useState, useEffect, useCallback } from 'react'
import SessionPanel from './components/SessionPanel.jsx'
import ChatInterface from './components/ChatInterface.jsx'
import DBInspector from './components/DBInspector.jsx'
import { createSession, listSessions, loadDBState, advanceSetupStage, seedBusinessProfile } from './lib/supabase.js'

const WEBHOOK_PATH = '/api/n8n/webhook/wa-inbound'

export default function App() {
  const [sessions, setSessions] = useState([])
  const [activeSession, setActiveSession] = useState(null)
  const [messages, setMessages] = useState([])
  const [dbState, setDbState] = useState({ session: null, draft: null, profile: null, messages: [] })
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)

  const refreshSessions = useCallback(async () => {
    try {
      const data = await listSessions()
      setSessions(data)
    } catch (e) {
      setError('Failed to load sessions: ' + e.message)
    }
  }, [])

  const refreshDB = useCallback(async (sessionId) => {
    if (!sessionId) return
    try {
      const state = await loadDBState(sessionId)
      setDbState(state)
    } catch (e) {
      console.error('DB refresh failed', e)
    }
  }, [])

  useEffect(() => { refreshSessions() }, [refreshSessions])

  async function handleCreateSession(sessionId, mode) {
    try {
      setError(null)
      await createSession(sessionId, mode)
      await refreshSessions()
      selectSession({ session_id: sessionId, session_mode: mode, setup_completed: mode !== 'setup', current_stage: mode === 'setup' ? 'setup_start' : 'start' })
    } catch (e) {
      setError('Failed to create session: ' + e.message)
    }
  }

  function selectSession(session) {
    setActiveSession(session)
    setMessages([])
    refreshDB(session.session_id)
  }

  async function handleSeedPreset(preset) {
    if (!activeSession) return
    try {
      setError(null)
      await seedBusinessProfile(activeSession.session_id, preset.profile)
      const updated = { ...activeSession, session_mode: 'live', setup_completed: true }
      setActiveSession(updated)
      await refreshSessions()
      await refreshDB(activeSession.session_id)
    } catch (e) {
      setError('Seed failed: ' + e.message)
    }
  }

  async function handleSendMessage(text) {
    if (!activeSession || !text.trim() || sending) return
    setSending(true)
    setError(null)

    const userMsg = { role: 'user', content: text, ts: Date.now() }
    setMessages(prev => [...prev, userMsg])

    try {
      const res = await fetch(WEBHOOK_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, session_id: activeSession.session_id })
      })

      const body = await res.json().catch(() => ({}))

      if (!res.ok || body.status === 'error') {
        throw new Error(body.message || body.error || `HTTP ${res.status}`)
      }

      const reply = body.message || body.result?.setup_response || body.result?.validated_response || '(no response)'
      const nextStage = body.state?.stage || body.result?.next_setup_stage || null

      setMessages(prev => [...prev, { role: 'assistant', content: reply, ts: Date.now(), stage: nextStage }])

      if (nextStage && activeSession.session_mode === 'setup') {
        await advanceSetupStage(activeSession.session_id, nextStage)
        setActiveSession(prev => ({ ...prev, current_stage: nextStage, current_setup_stage: nextStage }))
      }

      await refreshDB(activeSession.session_id)
    } catch (e) {
      setError('Webhook error: ' + e.message)
      setMessages(prev => [...prev, { role: 'error', content: e.message, ts: Date.now() }])
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <span className="logo">💬 WA Studio</span>
        <span className="header-sub">Business Agent Testing Environment</span>
        {error && <span className="header-error">{error}</span>}
      </header>
      <div className="app-body">
        <SessionPanel
          sessions={sessions}
          activeSession={activeSession}
          onSelect={selectSession}
          onCreate={handleCreateSession}
          onSeed={handleSeedPreset}
          onRefresh={refreshSessions}
        />
        <ChatInterface
          session={activeSession}
          messages={messages}
          sending={sending}
          onSend={handleSendMessage}
          onClear={() => setMessages([])}
        />
        <DBInspector
          dbState={dbState}
          onRefresh={() => refreshDB(activeSession?.session_id)}
        />
      </div>
    </div>
  )
}
