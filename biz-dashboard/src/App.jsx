import { useState, useEffect } from 'react'
import { supabase } from './lib/supabase'
import Overview from './pages/Overview'
import CRM from './pages/CRM'

const NAV = [
  { key: 'overview', label: 'סקירה',  icon: '📊' },
  { key: 'crm',      label: 'לידים',  icon: '👥' },
]

async function getDevBusiness() {
  const { data } = await supabase
    .from('businesses')
    .select('id, name')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data
}

export default function App() {
  const [page, setPage]         = useState('overview')
  const [business, setBusiness] = useState(null)
  const [loading, setLoading]   = useState(true)

  useEffect(() => {
    getDevBusiness().then(biz => { setBusiness(biz); setLoading(false) })
  }, [])

  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', color:'var(--text-muted)' }}>
      טוען...
    </div>
  )

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-logo">🤖 WAgent</div>
        {business && (
          <div className="sidebar-biz">
            דשבורד עסקי
            <strong>{business.name}</strong>
          </div>
        )}
        <nav className="sidebar-nav">
          {NAV.map(n => (
            <button
              key={n.key}
              className={`nav-item ${page === n.key ? 'active' : ''}`}
              onClick={() => setPage(n.key)}
            >
              <span>{n.icon}</span>{n.label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="main">
        {!business ? (
          <div className="empty">לא נמצא עסק — ודא שהשלמת את ההגדרות ב-WA Studio</div>
        ) : page === 'overview' ? (
          <Overview businessId={business.id} businessName={business.name} />
        ) : (
          <CRM businessId={business.id} />
        )}
      </main>
    </div>
  )
}
