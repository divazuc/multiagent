import React, { useState, useMemo } from 'react'
import ReactDOM from 'react-dom/client'
import ClientDashboard from '../demo/ClientDashboard.jsx'
import { createPortalApi, portalLogin } from '../demo/api.js'
import '../demo/demo.css'

const STORAGE_KEY = 'wa_portal_auth'

function loadAuth() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const auth = JSON.parse(raw)
    return auth?.token && auth?.business?.id ? auth : null
  } catch { return null }
}

function LoginScreen({ onLogin }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const { token, business } = await portalLogin(email, password)
      onLogin({ token, business })
    } catch (err) {
      setError(err.message === 'אימייל או סיסמה שגויים' ? err.message : 'ההתחברות נכשלה — נסו שוב')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pt-login-page">
      <div className="pt-login-card">
        <div className="pt-login-mark">💬</div>
        <h1>אזור אישי</h1>
        <p className="pt-login-sub">מרכז הלידים והסוכן החכם של העסק שלך</p>
        <form onSubmit={submit}>
          <label className="fq-modal-label" htmlFor="pt-email">אימייל</label>
          <input id="pt-email" type="email" autoComplete="username" dir="ltr"
                 value={email} onChange={e => setEmail(e.target.value)} required />
          <label className="fq-modal-label" htmlFor="pt-pass">סיסמה</label>
          <input id="pt-pass" type="password" autoComplete="current-password" dir="ltr"
                 value={password} onChange={e => setPassword(e.target.value)} required />
          {error && <div className="pt-login-error">{error}</div>}
          <button className="st-save pt-login-btn" type="submit" disabled={busy}>
            {busy ? 'מתחבר…' : 'כניסה'}
          </button>
        </form>
        <div className="pt-login-foot">אין לך פרטי התחברות? פנו אלינו ונשמח להסדיר גישה.</div>
      </div>
    </div>
  )
}

function PortalApp() {
  const [auth, setAuth] = useState(loadAuth)

  const logout = () => { localStorage.removeItem(STORAGE_KEY); setAuth(null) }

  const api = useMemo(
    () => auth ? createPortalApi(auth.token, auth.business, logout) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [auth]
  )

  if (!auth) {
    return <LoginScreen onLogin={(a) => { localStorage.setItem(STORAGE_KEY, JSON.stringify(a)); setAuth(a) }} />
  }

  return <ClientDashboard api={api} businessName={auth.business.name} onLogout={logout} />
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <PortalApp />
  </React.StrictMode>
)
