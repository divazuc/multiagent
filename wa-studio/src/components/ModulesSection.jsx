import { useState, useEffect } from 'react'
import { getModules, updateModule, createConnectLink } from '../lib/supabase.js'

const DAY_LABELS = { sun: 'א׳', mon: 'ב׳', tue: 'ג׳', wed: 'ד׳', thu: 'ה׳', fri: 'ו׳', sat: 'ש׳' }
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const st = {
  card: { border: '1px solid var(--border)', borderRadius: 10, padding: 14, marginTop: 10, background: 'var(--surface-2)' },
  row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  dot: (c) => ({ width: 10, height: 10, borderRadius: 5, background: c, display: 'inline-block', flexShrink: 0 }),
  num: { width: 64, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' },
  time: { padding: '5px 6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' },
  btn: { padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer' },
  label: { fontSize: 12, color: 'var(--text-muted)' },
}

function CalendarSettings({ mod, onChange }) {
  const s = mod.settings
  const set = (patch) => onChange({ ...s, ...patch })
  const setDay = (day, windows) => set({ weekly: { ...s.weekly, [day]: windows } })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
      <div style={st.row}>
        <span style={st.label}>מצב קביעה:</span>
        <select value={s.mode} onChange={e => set({ mode: e.target.value })} style={st.time}>
          <option value="owner_confirmed">באישור בעל העסק</option>
          <option value="autonomous">אוטונומי — הבוט קובע</option>
        </select>
        <span style={st.label}>משך (דק'):</span>
        <input type="number" style={st.num} value={s.duration_min} onChange={e => set({ duration_min: +e.target.value })} />
        <span style={st.label}>מרווח (דק'):</span>
        <input type="number" style={st.num} value={s.buffer_min} onChange={e => set({ buffer_min: +e.target.value })} />
        <span style={st.label}>התראה מראש (שעות):</span>
        <input type="number" style={st.num} value={s.min_notice_hours} onChange={e => set({ min_notice_hours: +e.target.value })} />
      </div>
      <div>
        <div style={{ ...st.label, marginBottom: 6 }}>שעות פנויות לפגישות (נפרד משעות המענה של הבוט):</div>
        {DAYS.map(day => {
          const w = s.weekly?.[day] ?? []
          const first = w[0]
          return (
            <div key={day} style={{ ...st.row, marginBottom: 4 }}>
              <span style={{ width: 20 }}>{DAY_LABELS[day]}</span>
              <input type="checkbox" checked={!!first} onChange={e => setDay(day, e.target.checked ? [{ from: '09:00', to: '17:00' }] : [])} />
              {first && (<>
                <input type="time" style={st.time} value={first.from} onChange={e => setDay(day, [{ ...first, from: e.target.value }])} />
                <span>–</span>
                <input type="time" style={st.time} value={first.to} onChange={e => setDay(day, [{ ...first, to: e.target.value }])} />
              </>)}
            </div>
          )
        })}
      </div>
      <div style={st.row}>
        <label style={st.label}>
          <input type="checkbox" checked={s.jewish_holidays_closed} onChange={e => set({ jewish_holidays_closed: e.target.checked })} /> סגור בחגים
        </label>
        <span style={st.label}>טלפון בעל העסק להתראות:</span>
        <input style={{ ...st.num, width: 130 }} value={s.owner_notify_phone ?? ''} placeholder="9725..." onChange={e => set({ owner_notify_phone: e.target.value })} />
      </div>
    </div>
  )
}

export default function ModulesSection({ business }) {
  const [mods, setMods] = useState(null)
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState(null)
  const [msg, setMsg] = useState(null)

  useEffect(() => { getModules(business.id).then(setMods).catch(e => setMsg(e.message)) }, [business.id])
  if (!mods) return <div style={{ ...st.label, marginTop: 18 }}>{msg ?? 'טוען מודולים…'}</div>

  const patch = (key, p) => setMods(mods.map(m => m.key === key ? { ...m, ...p } : m))

  async function save(mod) {
    setBusy(true); setMsg(null)
    try {
      await updateModule(business.id, mod.key, { enabled: mod.enabled, settings: mod.settings })
      setMsg('נשמר ✓')
    } catch (e) { setMsg(e.message) } finally { setBusy(false) }
  }

  async function connect(mod) {
    setBusy(true)
    try { setLink((await createConnectLink(business.id, mod.key)).url) }
    catch (e) { setMsg(e.message) } finally { setBusy(false) }
  }

  const statusColor = { connected: '#22c55e', error: '#ef4444', disconnected: '#94a3b8' }

  return (
    <div style={{ marginTop: 18 }}>
      <h3 style={{ margin: '0 0 4px' }}>מודולים</h3>
      {mods.map(mod => (
        <div key={mod.key} style={st.card}>
          <div style={st.row}>
            <span style={st.dot(statusColor[mod.status] ?? '#94a3b8')} />
            <strong>{mod.name}</strong>
            <label style={{ marginInlineStart: 'auto', fontSize: 13 }}>
              <input type="checkbox" checked={mod.enabled} onChange={e => patch(mod.key, { enabled: e.target.checked })} /> פעיל
            </label>
          </div>
          {mod.status === 'connected' && mod.status_detail && <div style={st.label}>מחובר: {mod.status_detail}</div>}
          {mod.status === 'error' && <div style={{ ...st.label, color: '#ef4444' }}>שגיאת חיבור: {mod.status_detail ?? 'נדרש חיבור מחדש'}</div>}
          {mod.key === 'calendar' && (
            <CalendarSettings mod={mod} onChange={(settings) => patch(mod.key, { settings })} />
          )}
          <div style={{ ...st.row, marginTop: 10 }}>
            <button style={st.btn} disabled={busy} onClick={() => save(mod)}>שמירת מודול</button>
            {mod.adminUI?.connectType === 'google_oauth' && (
              <button style={st.btn} disabled={busy} onClick={() => connect(mod)}>צור קישור חיבור יומן</button>
            )}
          </div>
          {link && (
            <div style={{ marginTop: 8 }}>
              <input readOnly value={link} style={{ width: '100%', boxSizing: 'border-box', ...st.time }} onFocus={e => e.target.select()} />
              <div style={st.label}>שלחו את הקישור ללקוח — הוא מאשר עם חשבון Google שלו (תקף 48 שעות).</div>
            </div>
          )}
        </div>
      ))}
      {msg && <div style={{ ...st.label, marginTop: 6 }}>{msg}</div>}
    </div>
  )
}
