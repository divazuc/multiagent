import { useState, useEffect, useCallback } from 'react'
import Login from './components/Login.jsx'
import { logError } from './components/ErrorBoundary.jsx'
import SessionPanel from './components/SessionPanel.jsx'
import ChatInterface from './components/ChatInterface.jsx'
import DBInspector from './components/DBInspector.jsx'
import RunsPanel from './components/RunsPanel.jsx'
import SetupWizard from './components/SetupWizard.jsx'
import BusinessPreferences from './components/BusinessPreferences.jsx'
import { createSession, listSessions, loadDBState, advanceSetupStage, markSetupComplete, seedBusinessProfile, clearSessionData, seedFaqStarters, setSessionMode, loadSuggestedFaqCount } from './lib/supabase.js'
import FaqPanel from './components/FaqModal.jsx'

const AGENT_BASE = import.meta.env.VITE_AGENT_URL ?? ''
const WEBHOOK_PATH = AGENT_BASE ? `${AGENT_BASE}/wa-inbound` : '/api/agent/wa-inbound'

export default function App() {
  const isDev = import.meta.env.DEV
  const [authed, setAuthed] = useState(() => isDev || localStorage.getItem('wa_studio_auth') === '1')
  const [sessions, setSessions] = useState([])
  const [activeSession, setActiveSession] = useState(null)
  const [messages, setMessages] = useState([])
  const [dbState, setDbState] = useState({ session: null, draft: null, profile: null, messages: [] })
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [faqOpen, setFaqOpen]   = useState(false)
  const [suggestedCount, setSuggestedCount] = useState(0)
  const [prefsOpen, setPrefsOpen] = useState(false)
  const [rightPanel, setRightPanel] = useState('db') // 'db' | 'runs'
  const [showSessions, setShowSessions] = useState(false)
  const [showRight, setShowRight] = useState(false)

  const refreshSessions = useCallback(async () => {
    try {
      const data = await listSessions()
      setSessions(data)
    } catch (e) {
      setError('Failed to load sessions: ' + e.message)
    }
  }, [])

  const refreshSuggestedCount = useCallback(async (businessId) => {
    if (!businessId) { setSuggestedCount(0); return }
    try {
      const count = await loadSuggestedFaqCount(businessId)
      setSuggestedCount(count)
    } catch { setSuggestedCount(0) }
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
    const stageAdvanced = stage && !['collect_business_model', 'business_details', 'business_type', 'setup_start', 'start'].includes(stage)
    const hasHistory = dbState.messages?.length > 0 || stageAdvanced

    if (hasHistory) {
      const count = dbState.messages?.length || 0
      const lines = [
        `↩️ ממשיכים מאיפה שעצרנו — ${name}`,
        count > 0 ? `${count} הודעות בהיסטוריה — שלח הודעה להמשיך.` : `שלח הודעה להמשיך מהשלב הנוכחי.`,
      ]
      return { role: 'welcome', content: lines.join('\n'), ts: Date.now() }
    }

    if (mode === 'setup') {
      return {
        role: 'welcome',
        content: `👋 ברוכים הבאים! בואו נגדיר את הסוכן עבור ${name}.\n\nנעבור יחד על כמה שאלות קצרות:\n  • סוג העסק\n  • נושאי FAQ\n  • מטרת הסוכן\n  • סגנון ואישיות\n\nהתחל בלחיצה על הבחירה הראשונה.`,
        ts: Date.now(),
      }
    }

    if (mode === 'live') {
      return {
        role: 'welcome',
        content: `🤖 סשן בדיקה חי עבור ${name}.\n\nהסוכן פעיל. שלח הודעה כאילו אתה לקוח פוטנציאלי והסוכן יענה.`,
        ts: Date.now(),
      }
    }

    return {
      role: 'welcome',
      content: `🎓 שלב הדמו עבור ${name}.\n\nהסוכן בשלב למידה. שלח הודעות כדי לאמן את הסוכן על סגנון הדיבור שלך.`,
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
      await selectSession(session)
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
        setMessages(prev => {
          const next = [...prev, { role: 'assistant', content: reply, ts: Date.now() }]
          if (body.result?.is_done) next.push({ role: 'cta', type: 'live', ts: Date.now() + 1 })
          return next
        })
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
    refreshSuggestedCount(session.business_id)
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

  async function handleToggleActive(active) {
    if (!activeSession?.business_id) return
    try {
      await fetch(`${AGENT_BASE ? AGENT_BASE : '/api/agent'}/business/toggle-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: activeSession.business_id, active }),
      })
      await refreshDB(activeSession.session_id)
    } catch (e) {
      setError('Toggle failed: ' + e.message)
    }
  }

  async function handleActivateLive() {
    if (!activeSession) return
    try {
      setError(null)
      await setSessionMode(activeSession.session_id, 'live')
      setActiveSession(prev => ({ ...prev, session_mode: 'live' }))
      await refreshSessions()
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: '\u{1F7E2} \u05de\u05e6\u05d1 \u05dc\u05d9\u05d9\u05d1 \u05d4\u05d5\u05e4\u05e2\u05dc \u2014 \u05e9\u05dc\u05d7\u05d5 \u05d4\u05d5\u05d3\u05e2\u05ea \u05dc\u05e7\u05d5\u05d7 \u05dc\u05d1\u05d3\u05d9\u05e7\u05d4.',
        ts: Date.now(),
      }])
    } catch (e) {
      setError('Activate live failed: ' + e.message)
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

      setMessages(prev => {
        const next = [...prev, { role: 'assistant', content: reply, ts: Date.now(), stage: nextStage }]
        if (body.result?.is_done && activeSession.session_mode === 'learning') {
          next.push({ role: 'cta', type: 'live', ts: Date.now() + 1 })
        }
        return next
      })

      if (nextStage && activeSession.session_mode === 'setup') {
        await advanceSetupStage(activeSession.session_id, nextStage)
        setActiveSession(prev => ({ ...prev, current_stage: nextStage, current_setup_stage: nextStage }))
      }

      if (action === 'commit' && activeSession.business_id) {
        await markSetupComplete(activeSession.session_id).catch(e => console.warn('markSetupComplete failed:', e))
        setActiveSession(prev => ({ ...prev, setup_completed: true }))
        const draft = dbState.draft?.draft_setup_data
        const archetype = draft?.archetype || draft?.collect_business_model || body.result?.archetype
        if (!archetype) console.warn('FAQ seed: archetype missing, defaulting to service', draft)
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

  if (!authed) return <Login onLogin={() => setAuthed(true)} />

  return (
    <div className="app">
      <header className="app-header">
        {/* Mobile: hamburger to open sessions */}
        <button className="mobile-toggle" onClick={() => setShowSessions(v => !v)} title="Sessions">☰</button>

        <span className="logo">💬 WA Studio</span>
        <span className="header-sub">סביבת בדיקה לסוכן עסקי</span>
        {error && <span className="header-error">{error}</span>}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
          <button
            onClick={() => setRightPanel('db')}
            style={{ fontSize: 11, padding: '3px 10px', borderRadius: 4, border: 'none', cursor: 'pointer', background: rightPanel === 'db' ? 'var(--accent)' : 'var(--surface-3)', color: 'var(--text)' }}
          >DB</button>
          <button
            onClick={() => setRightPanel('runs')}
            style={{ fontSize: 11, padding: '3px 10px', borderRadius: 4, border: 'none', cursor: 'pointer', background: rightPanel === 'runs' ? 'var(--accent)' : 'var(--surface-3)', color: 'var(--text)' }}
          >Runs</button>
          {/* Mobile: toggle right panel */}
          <button className="mobile-toggle" onClick={() => setShowRight(v => !v)} title="Inspector">🔍</button>
        </div>
      </header>
      <div className="app-body">
        {/* Overlay for mobile drawers */}
        <div
          className={`drawer-overlay ${showSessions || showRight ? 'open' : ''}`}
          onClick={() => { setShowSessions(false); setShowRight(false) }}
        />

        <SessionPanel
          sessions={sessions}
          activeSession={activeSession}
          onSelect={(s) => { selectSession(s); setShowSessions(false) }}
          onCreate={handleCreateSession}
          onRestart={handleRestartSession}
          onSeed={handleSeedPreset}
          onRefresh={refreshSessions}
          className={showSessions ? 'open' : ''}
        />
        {prefsOpen && activeSession?.business_id && dbState.profile
          ? (
            <BusinessPreferences
              session={activeSession}
              profile={dbState.profile}
              onClose={() => setPrefsOpen(false)}
              onSaved={() => refreshDB(activeSession?.session_id)}
            />
          ) : faqOpen && activeSession?.business_id
          ? (
            <FaqPanel
              businessId={activeSession.business_id}
              businessName={activeSession.business_name || activeSession.session_id}
              businessCategory={dbState.profile?.business_category ?? ''}
              onClose={() => { setFaqOpen(false); refreshSuggestedCount(activeSession.business_id) }}
            />
          ) : activeSession?.session_mode === 'setup' && !activeSession?.setup_completed
          ? (
            <SetupWizard
              session={activeSession}
              draft={dbState.draft?.draft_setup_data ?? null}
              sending={sending}
              onSend={handleSendMessage}
              onRefreshDB={() => refreshDB(activeSession?.session_id)}
              onCommitted={async () => {
                await refreshSessions()
                const updated = await refreshDB(activeSession?.session_id)
                setActiveSession(prev => prev ? { ...prev, setup_completed: true, session_mode: 'live' } : prev)
              }}
            />
          ) : (
            <ChatInterface
              session={activeSession ? { ...activeSession, draft_setup_data: dbState.draft?.draft_setup_data || null } : null}
              messages={messages}
              sending={sending}
              onSend={handleSendMessage}
              onClear={() => setMessages([])}
              onStartOnboarding={() => activeSession && handleRestartSession(activeSession, 'learning', activeSession.business_id)}
              onActivateLive={handleActivateLive}
              onOpenFaq={() => setFaqOpen(true)}
              onOpenPrefs={() => setPrefsOpen(true)}
              agentActive={dbState.profile?.agent_active ?? true}
              onToggleActive={handleToggleActive}
              suggestedCount={suggestedCount}
            />
          )
        }
        <div className={`panel panel-right ${showRight ? 'open' : ''}`}>
          {rightPanel === 'runs'
            ? <RunsPanel activeSession={activeSession} />
            : <DBInspector dbState={dbState} onRefresh={() => refreshDB(activeSession?.session_id)} />
          }
        </div>
      </div>
    </div>
  )
}
