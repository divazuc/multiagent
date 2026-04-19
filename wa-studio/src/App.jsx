import { useState, useEffect, useCallback } from 'react'
import SessionPanel from './components/SessionPanel.jsx'
import ChatInterface from './components/ChatInterface.jsx'
import DBInspector from './components/DBInspector.jsx'
import { createSession, listSessions, loadDBState, advanceSetupStage, markSetupComplete, seedBusinessProfile, clearSessionData, seedFaqStarters } from './lib/supabase.js'
import FaqModal from './components/FaqModal.jsx'

const WEBHOOK_PATH = '/api/n8n/webhook/wa-inbound'

export default function App() {
  const [sessions, setSessions] = useState([])
  const [activeSession, setActiveSession] = useState(null)
  const [messages, setMessages] = useState([])
  const [dbState, setDbState] = useState({ session: null, draft: null, profile: null, messages: [] })
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [faqOpen, setFaqOpen] = useState(false)

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

  function buildWelcomeMessage(session, dbState) {
    const name = session.business_name || session.session_id
    const mode = session.session_mode
    const stage = session.current_setup_stage || session.current_stage
    const stageAdvanced = stage && stage !== 'collect_business_model' && stage !== 'setup_start' && stage !== 'start'
    const hasHistory = dbState.messages?.length > 0 || stageAdvanced

    if (hasHistory) {
      const count = dbState.messages?.length || 0
      const lines = [
        `↩️ Resuming session for ${name}`,
        `Mode: ${mode}${stage ? ` · Stage: ${stage}` : ''}${session.setup_completed ? ' · Setup complete ✓' : ''}`,
        count > 0
          ? `${count} message${count !== 1 ? 's' : ''} in history — send a message to continue.`
          : `Send a message to continue from the current stage.`,
      ]
      return { role: 'welcome', content: lines.join('\n'), ts: Date.now() }
    }

    if (mode === 'setup') {
      return {
        role: 'welcome',
        content: `👋 Welcome! Let's set up ${name}.\n\nI'll walk you through a few questions to configure the AI sales agent:\n  • Business type & services\n  • Target audience\n  • Sales goals & guardrails\n\nSend any message to begin.`,
        ts: Date.now(),
      }
    }

    if (mode === 'live') {
      return {
        role: 'welcome',
        content: `🤖 Live test session started for ${name}.\n\nThe conversation engine is active. Send a message as if you're a customer and the agent will respond.\n\nTip: use "Seed Profile" in the sidebar to inject a business profile if setup isn't complete yet.`,
        ts: Date.now(),
      }
    }

    return {
      role: 'welcome',
      content: `🎓 Demo session started for ${name}.\n\nThe agent is in learning mode. Send messages to explore the conversation flow.`,
      ts: Date.now(),
    }
  }

  async function handleCreateSession(sessionId, mode, businessId = null) {
    try {
      setError(null)
      const session = await createSession(sessionId, mode, businessId)
      await refreshSessions()
      selectSession(session)
    } catch (e) {
      setError('Failed to create session: ' + e.message)
    }
  }

  async function handleRestartSession(existingSession, mode, businessId) {
    try {
      setError(null)
      await clearSessionData(existingSession.session_id)
      await refreshSessions()
      const newSessionId = `${businessId.slice(0, 8)}_${Date.now()}`
      const session = await createSession(newSessionId, mode, businessId)
      await refreshSessions()
      selectSession(session)
      if (mode === 'learning') {
        await autoStartOnboarding(session)
      }
    } catch (e) {
      setError('Failed to restart session: ' + e.message)
    }
  }

  async function autoStartOnboarding(session) {
    setSending(true)
    try {
      const res = await fetch(WEBHOOK_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'start', session_id: session.session_id, business_id: session.business_id || null })
      })
      const body = await res.json().catch(() => ({}))
      if (res.ok && body.status !== 'error') {
        const reply = body.message || body.result?.onboarding_response || '(no response)'
        setMessages(prev => [...prev, { role: 'assistant', content: reply, ts: Date.now() }])
      }
    } catch (e) {
      console.warn('Auto-start onboarding failed:', e)
    } finally {
      setSending(false)
    }
  }

  async function selectSession(session) {
    setActiveSession(session)
    setMessages([])
    try {
      const state = await loadDBState(session.session_id)
      setDbState(state)
      const msgs = [buildWelcomeMessage(session, state)]
      const lastAssistant = [...(state.messages || [])].reverse().find(m => m.agent_response)
      if (lastAssistant) {
        msgs.push({ role: 'assistant', content: lastAssistant.agent_response, ts: new Date(lastAssistant.created_at).getTime(), stage: lastAssistant.setup_stage || lastAssistant.stage || null })
      }
      if (session.setup_completed && session.session_mode === 'setup' && session.business_id) {
        msgs.push({ role: 'cta', type: 'onboarding', ts: Date.now() })
      }
      setMessages(msgs)
      if (session.session_mode === 'learning' && !state.messages?.length) {
        await autoStartOnboarding(session)
      }
    } catch (e) {
      console.error('DB refresh failed', e)
      setMessages([buildWelcomeMessage(session, { messages: [] })])
    }
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
        body: JSON.stringify({ message: text, session_id: activeSession.session_id, business_id: activeSession.business_id || null })
      })

      const body = await res.json().catch(() => ({}))

      if (!res.ok || body.status === 'error') {
        throw new Error(body.message || body.error || `HTTP ${res.status}`)
      }

      const reply = body.message || body.result?.setup_response || body.result?.validated_response || '(no response)'
      const nextStage = body.state?.stage || body.result?.next_setup_stage || null
      const action = body.result?.action || null

      setMessages(prev => [...prev, { role: 'assistant', content: reply, ts: Date.now(), stage: nextStage }])

      if (nextStage && activeSession.session_mode === 'setup') {
        await advanceSetupStage(activeSession.session_id, nextStage)
        setActiveSession(prev => ({ ...prev, current_stage: nextStage, current_setup_stage: nextStage }))
      }

      if (action === 'commit' && activeSession.business_id) {
        await markSetupComplete(activeSession.session_id).catch(e => console.warn('markSetupComplete failed:', e))
        setActiveSession(prev => ({ ...prev, setup_completed: true }))
        const archetype = dbState.draft?.draft_setup_data?.archetype
        await seedFaqStarters(activeSession.business_id, archetype).catch(e => console.warn('FAQ seed failed:', e))
        setMessages(prev => [...prev, { role: 'cta', type: 'onboarding', ts: Date.now() }])
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
        <span className="header-sub">סביבת בדיקה לסוכן עסקי</span>
        {error && <span className="header-error">{error}</span>}
      </header>
      <div className="app-body">
        <SessionPanel
          sessions={sessions}
          activeSession={activeSession}
          onSelect={selectSession}
          onCreate={handleCreateSession}
          onRestart={handleRestartSession}
          onSeed={handleSeedPreset}
          onRefresh={refreshSessions}
        />
        <ChatInterface
          session={activeSession ? { ...activeSession, draft_setup_data: dbState.draft?.draft_setup_data || null } : null}
          messages={messages}
          sending={sending}
          onSend={handleSendMessage}
          onClear={() => setMessages([])}
          onStartOnboarding={() => activeSession && handleRestartSession(activeSession, 'learning', activeSession.business_id)}
          onOpenFaq={() => setFaqOpen(true)}
        />
        {faqOpen && activeSession?.business_id && (
          <FaqModal
            businessId={activeSession.business_id}
            businessName={activeSession.business_name || activeSession.session_id}
            onClose={() => setFaqOpen(false)}
          />
        )}
        <DBInspector
          dbState={dbState}
          onRefresh={() => refreshDB(activeSession?.session_id)}
        />
      </div>
    </div>
  )
}
