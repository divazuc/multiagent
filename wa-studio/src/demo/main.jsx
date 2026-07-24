import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import ClientDashboard from './ClientDashboard.jsx'
import Login from '../components/Login.jsx'
import { getAdminKey, clearAdminKey, installAdminFetch } from '../lib/adminAuth.js'
import './demo.css'

// The demo dashboard reads real business data through the operator endpoints,
// so it sits behind the same operator login as the Studio. Clients get their
// own authenticated view at /portal — this page is for pitch meetings only.
function DemoGate() {
  const [authed, setAuthed] = useState(() => !!getAdminKey())
  installAdminFetch(() => { clearAdminKey(); setAuthed(false) })
  if (!authed) {
    return <Login subtitle="דאשבורד דמו — גישה למפעיל בלבד" onLogin={() => setAuthed(true)} />
  }
  return <ClientDashboard />
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <DemoGate />
  </React.StrictMode>
)
