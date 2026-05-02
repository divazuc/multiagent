import { useState } from 'react'

export default function Login({ onLogin }) {
  const [user, setUser]     = useState('')
  const [pass, setPass]     = useState('')
  const [error, setError]   = useState(false)
  const [loading, setLoading] = useState(false)

  function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError(false)

    const validUser = import.meta.env.VITE_ADMIN_USER
    const validPass = import.meta.env.VITE_ADMIN_PASS

    setTimeout(() => {
      if (user === validUser && pass === validPass) {
        localStorage.setItem('wa_studio_auth', '1')
        onLogin()
      } else {
        setError(true)
        setPass('')
      }
      setLoading(false)
    }, 400)
  }

  return (
    <div style={{
      height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)', flexDirection: 'column', gap: 24,
    }}>
      <div style={{ textAlign: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>💬</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--accent)' }}>WA Studio</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>סביבת בדיקה לסוכן עסקי</div>
      </div>

      <form onSubmit={handleSubmit} style={{
        background: 'var(--surface)', borderRadius: 12, padding: 28,
        display: 'flex', flexDirection: 'column', gap: 14,
        width: 300, border: '1px solid var(--border)',
      }}>
        <input
          type="text"
          placeholder="Username"
          value={user}
          onChange={e => setUser(e.target.value)}
          autoComplete="username"
          required
          style={{
            padding: '10px 14px', borderRadius: 8, border: `1px solid ${error ? '#f87171' : 'var(--border)'}`,
            background: 'var(--surface-2)', color: 'var(--text)', fontSize: 14, outline: 'none',
          }}
        />
        <input
          type="password"
          placeholder="Password"
          value={pass}
          onChange={e => setPass(e.target.value)}
          autoComplete="current-password"
          required
          style={{
            padding: '10px 14px', borderRadius: 8, border: `1px solid ${error ? '#f87171' : 'var(--border)'}`,
            background: 'var(--surface-2)', color: 'var(--text)', fontSize: 14, outline: 'none',
          }}
        />
        {error && (
          <div style={{ fontSize: 12, color: '#f87171', textAlign: 'center' }}>
            Invalid username or password
          </div>
        )}
        <button type="submit" disabled={loading || !user || !pass} style={{
          padding: '11px', borderRadius: 8, border: 'none',
          background: 'var(--accent)', color: '#fff',
          fontWeight: 700, fontSize: 14, cursor: loading ? 'default' : 'pointer',
          opacity: loading || !user || !pass ? 0.6 : 1,
        }}>
          {loading ? '...' : 'Sign In'}
        </button>
      </form>
    </div>
  )
}
