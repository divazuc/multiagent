import { Component } from 'react'

const AGENT_BASE = import.meta.env.VITE_AGENT_URL ?? ''
const LOG_URL = AGENT_BASE ? `${AGENT_BASE}/log/error` : '/api/agent/log/error'

export function logError(message, source = 'runtime', stack = '') {
  try {
    fetch(LOG_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: String(message).slice(0, 500),
        source,
        stack: String(stack).slice(0, 1000),
        url: window.location.href,
        ts: new Date().toISOString(),
      }),
    }).catch(() => {}) // never throw from logger
  } catch {}
}

// ── Global JS error listeners ─────────────────────────────────────────────────
if (typeof window !== 'undefined') {
  window.onerror = (msg, src, line, col, err) => {
    logError(msg, `${src}:${line}:${col}`, err?.stack)
    showToast(`JS Error: ${String(msg).slice(0, 120)}`)
    return false
  }

  window.onunhandledrejection = (e) => {
    const msg = e.reason?.message ?? String(e.reason) ?? 'Unhandled promise rejection'
    logError(msg, 'promise', e.reason?.stack)
    showToast(`Unhandled error: ${String(msg).slice(0, 120)}`)
  }
}

function showToast(message) {
  const existing = document.getElementById('wa-error-toast')
  if (existing) existing.remove()

  const toast = document.createElement('div')
  toast.id = 'wa-error-toast'
  toast.style.cssText = `
    position:fixed; bottom:16px; left:50%; transform:translateX(-50%);
    background:#3b1a1a; color:#fca5a5; border:1px solid #7f1d1d;
    padding:10px 16px; border-radius:8px; font-size:12px; z-index:9999;
    max-width:90vw; word-break:break-word; box-shadow:0 4px 12px rgba(0,0,0,0.4);
    font-family:-apple-system,sans-serif; cursor:pointer;
  `
  toast.textContent = `⚠️ ${message}`
  toast.onclick = () => toast.remove()
  document.body.appendChild(toast)
  setTimeout(() => toast?.remove(), 8000)
}

// ── React Error Boundary ──────────────────────────────────────────────────────
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    logError(error.message, 'react-render', error.stack + '\n' + info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children

    const err = this.state.error

    return (
      <div style={{
        height: '100vh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 16,
        background: '#0b141a', color: '#e9edef', fontFamily: 'sans-serif', padding: 24,
      }}>
        <div style={{ fontSize: 32 }}>⚠️</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#fca5a5' }}>Something went wrong</div>
        <div style={{
          background: '#1a0f0f', border: '1px solid #7f1d1d', borderRadius: 8,
          padding: 16, maxWidth: 600, width: '100%',
          fontFamily: 'monospace', fontSize: 12, color: '#fca5a5',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 200, overflowY: 'auto',
        }}>
          {err.message}
          {err.stack && '\n\n' + err.stack.split('\n').slice(1, 6).join('\n')}
        </div>
        <button
          onClick={() => { this.setState({ error: null }); window.location.reload() }}
          style={{
            padding: '10px 24px', borderRadius: 8, border: 'none',
            background: '#00a884', color: '#fff', cursor: 'pointer',
            fontWeight: 600, fontSize: 14,
          }}
        >
          Reload
        </button>
      </div>
    )
  }
}
