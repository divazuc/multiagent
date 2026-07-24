import { useState } from 'react'
import { setAdminKey, verifyAdminKey } from '../lib/adminAuth.js'

// Operator login: the password is the server's ADMIN_API_KEY, validated
// against /auth/check before it is stored. Client portal users never see
// this screen — they log in at /portal with their own credentials.
export default function Login({ onLogin, subtitle = 'סביבת ניהול — גישה למפעיל בלבד' }) {
  const [pass, setPass] = useState('')
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError(false)
    const ok = await verifyAdminKey(pass)
    if (ok) {
      setAdminKey(pass)
      onLogin()
    } else {
      setError(true)
      setPass('')
    }
    setLoading(false)
  }

  return (
    <div style={{
      height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg, #f4f6fb)', flexDirection: 'column', gap: 24, direction: 'rtl',
    }}>
      <div style={{ textAlign: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>💬</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--accent, #0d9488)' }}>WA Studio</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted, #64748b)', marginTop: 4 }}>{subtitle}</div>
      </div>

      <form onSubmit={handleSubmit} style={{
        background: 'var(--surface, #fff)', borderRadius: 12, padding: 28,
        display: 'flex', flexDirection: 'column', gap: 14,
        width: 300, border: '1px solid var(--border, #e2e8f0)',
      }}>
        <input
          type="password"
          placeholder="סיסמת מנהל"
          value={pass}
          onChange={e => setPass(e.target.value)}
          autoComplete="current-password"
          autoFocus
          required
          style={{
            padding: '10px 14px', borderRadius: 8, border: `1px solid ${error ? '#f87171' : 'var(--border, #e2e8f0)'}`,
            background: 'var(--surface-2, #f8fafc)', color: 'var(--text, #0f172a)', fontSize: 14, outline: 'none',
          }}
        />
        {error && (
          <div style={{ fontSize: 12, color: '#f87171', textAlign: 'center' }}>
            סיסמה שגויה
          </div>
        )}
        <button type="submit" disabled={loading || !pass} style={{
          padding: '11px', borderRadius: 8, border: 'none',
          background: 'var(--accent, #0d9488)', color: '#fff',
          fontWeight: 700, fontSize: 14, cursor: loading ? 'default' : 'pointer',
          opacity: loading || !pass ? 0.6 : 1,
        }}>
          {loading ? '...' : 'כניסה'}
        </button>
      </form>
    </div>
  )
}
