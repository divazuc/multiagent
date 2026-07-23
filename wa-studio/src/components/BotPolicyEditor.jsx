import { useState, useEffect } from 'react'
import { ESCALATION_OPTIONS, FORBIDDEN_OPTIONS, DAY_NAMES } from '../lib/botPolicy.js'

const AGENT_BASE = import.meta.env.VITE_AGENT_URL ?? ''
const api = (path) => AGENT_BASE ? `${AGENT_BASE}${path}` : `/api/agent${path}`

const DEFAULT_DAY = { active: false, from: '09:00', to: '19:00' }

const box = {
  overlay: { position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
  modal: { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, width: '100%', maxWidth: 720, maxHeight: '92vh', overflowY: 'auto', padding: '20px 22px' },
  h: { fontSize: 15, fontWeight: 700, marginBottom: 4 },
  sec: { marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border)' },
  secTitle: { fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: 'var(--text-muted)', marginBottom: 8 },
  check: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '4px 0', cursor: 'pointer' },
  input: { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)', font: 'inherit', fontSize: 13, padding: '8px 12px', width: '100%' },
  timeInput: { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', font: 'inherit', fontSize: 12, padding: '4px 8px' },
  btn: { border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', font: 'inherit', fontSize: 13, fontWeight: 600, padding: '8px 18px', borderRadius: 8, cursor: 'pointer' },
  btnPrimary: { border: 'none', background: 'var(--accent)', color: '#fff', font: 'inherit', fontSize: 13, fontWeight: 700, padding: '8px 22px', borderRadius: 8, cursor: 'pointer' },
}

function CheckGroup({ options, selected, onToggle, customValue, onCustom, customLabel }) {
  return (
    <div>
      {options.map(opt => (
        <label key={opt} style={box.check}>
          <input type="checkbox" checked={selected.includes(opt)} onChange={() => onToggle(opt)} />
          {opt}
        </label>
      ))}
      <label style={{ ...box.check, alignItems: 'flex-start', flexDirection: 'column', gap: 6, marginTop: 4 }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{customLabel}</span>
        <textarea rows={2} style={{ ...box.input, resize: 'vertical' }} value={customValue}
                  placeholder="אחר — פרטו תרחישים נוספים בשפה חופשית…"
                  onChange={e => onCustom(e.target.value)} />
      </label>
    </div>
  )
}

export default function BotPolicyEditor({ business, onClose, onSaved }) {
  const [state, setState] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(api('/studio/rpc'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fn: 'getBotSettings', args: [business.id] }),
        })
        const body = await res.json()
        const s = body.result ?? {}
        const g = s.guardrails ?? {}
        setState({
          guardrails: g,
          escalation_points: g.escalation_points ?? [],
          escalation_custom: g.escalation_custom ?? '',
          forbidden_topics: g.forbidden_topics ?? [],
          forbidden_custom: g.forbidden_custom ?? '',
          agent_active: s.agent_active !== false,
          answer_after_hours: s.answer_after_hours !== false,
          jewish_holidays: s.working_hours?.jewish_holidays !== false,
          days: Array.from({ length: 7 }, (_, i) => ({ ...DEFAULT_DAY, ...(s.working_hours?.days?.[i] ?? {}) })),
          after_hours_message: s.after_hours_message ?? '',
          followup_enabled: s.followup_enabled === true,
          followup_delay_days: s.followup_delay_days ?? 2,
          followup_message: s.followup_message ?? '',
        })
      } catch (e) { setError(e.message) }
    })()
  }, [business.id])

  function toggle(listKey, opt) {
    setState(s => ({
      ...s,
      [listKey]: s[listKey].includes(opt) ? s[listKey].filter(x => x !== opt) : [...s[listKey], opt],
    }))
  }

  function setDay(i, patch) {
    setState(s => ({ ...s, days: s.days.map((d, j) => j === i ? { ...d, ...patch } : d) }))
  }

  async function save() {
    setSaving(true); setError(null)
    try {
      const updates = {
        guardrails: {
          ...state.guardrails,
          escalation_points: state.escalation_points,
          escalation_custom: state.escalation_custom.trim(),
          forbidden_topics: state.forbidden_topics,
          forbidden_custom: state.forbidden_custom.trim(),
        },
        working_hours: {
          jewish_holidays: state.jewish_holidays,
          days: state.days.map(d => {
            const out = { active: d.active, from: d.from, to: d.to }
            if (d.from2 && d.to2) { out.from2 = d.from2; out.to2 = d.to2 }
            return out
          }),
        },
        agent_active: state.agent_active,
        answer_after_hours: state.answer_after_hours,
        after_hours_message: state.after_hours_message.trim() || null,
        followup_enabled: state.followup_enabled,
        followup_delay_days: Math.min(Math.max(Number(state.followup_delay_days) || 2, 1), 14),
        followup_message: state.followup_message.trim() || null,
      }
      const res = await fetch(api('/business/update'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: business.id, updates }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      onSaved?.()
      onClose()
    } catch (e) { setError(e.message) }
    finally { setSaving(false) }
  }

  return (
    <div style={box.overlay} onClick={onClose}>
      <div style={box.modal} onClick={e => e.stopPropagation()} dir="rtl">
        <div style={box.h}>⚙️ מדיניות הבוט — {business.name}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          ההגדרות כאן קובעות את התנהגות הבוט בשיחות; הלקוח רואה אותן בדשבורד שלו לקריאה בלבד.
        </div>

        {error && <div style={{ marginTop: 10, color: '#f87171', fontSize: 13 }}>{error}</div>}
        {!state && !error && <div style={{ marginTop: 20, color: 'var(--text-muted)', fontSize: 13 }}>טוען…</div>}

        {state && <>
          <div style={box.sec}>
            <div style={box.secTitle}>נקודות אסקלציה — מתי הבוט מעביר לנציג אנושי</div>
            <CheckGroup
              options={ESCALATION_OPTIONS}
              selected={state.escalation_points}
              onToggle={opt => toggle('escalation_points', opt)}
              customValue={state.escalation_custom}
              onCustom={v => setState(s => ({ ...s, escalation_custom: v }))}
              customLabel="תרחישים נוספים (אחר)"
            />
          </div>

          <div style={box.sec}>
            <div style={box.secTitle}>על מה אסור לבוט לענות</div>
            <CheckGroup
              options={FORBIDDEN_OPTIONS}
              selected={state.forbidden_topics}
              onToggle={opt => toggle('forbidden_topics', opt)}
              customValue={state.forbidden_custom}
              onCustom={v => setState(s => ({ ...s, forbidden_custom: v }))}
              customLabel="נושאים אסורים נוספים (אחר)"
            />
          </div>

          <div style={box.sec}>
            <div style={box.secTitle}>שעות פעילות</div>
            {state.days.map((d, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '3px 0', fontSize: 13 }}>
                <label style={{ ...box.check, width: 84 }}>
                  <input type="checkbox" checked={d.active} onChange={e => setDay(i, { active: e.target.checked })} />
                  {DAY_NAMES[i]}
                </label>
                {d.active ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <input type="time" style={box.timeInput} value={d.from} onChange={e => setDay(i, { from: e.target.value })} />
                    –
                    <input type="time" style={box.timeInput} value={d.to} onChange={e => setDay(i, { to: e.target.value })} />
                    {d.from2 !== undefined ? (
                      <>
                        <input type="time" style={box.timeInput} value={d.from2 || '16:00'} onChange={e => setDay(i, { from2: e.target.value })} />
                        –
                        <input type="time" style={box.timeInput} value={d.to2 || '19:00'} onChange={e => setDay(i, { to2: e.target.value })} />
                        <button style={{ ...box.btn, padding: '2px 8px', fontSize: 11 }} onClick={() => setDay(i, { from2: undefined, to2: undefined })}>✕</button>
                      </>
                    ) : (
                      <button style={{ ...box.btn, padding: '2px 10px', fontSize: 11 }} onClick={() => setDay(i, { from2: '16:00', to2: '19:00' })}>+ טווח</button>
                    )}
                  </span>
                ) : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>סגור</span>}
              </div>
            ))}
            <label style={{ ...box.check, marginTop: 6 }}>
              <input type="checkbox" checked={state.jewish_holidays} onChange={e => setState(s => ({ ...s, jewish_holidays: e.target.checked }))} />
              סגור בחגי ישראל
            </label>
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>הודעה אוטומטית מחוץ לשעות</div>
              <textarea rows={2} style={{ ...box.input, resize: 'vertical' }} value={state.after_hours_message}
                        onChange={e => setState(s => ({ ...s, after_hours_message: e.target.value }))} />
            </div>
          </div>

          <div style={box.sec}>
            <div style={box.secTitle}>מצב סוכן + פולו-אפ</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
              {[
                { label: 'פעיל תמיד (24/7)', active: state.agent_active && state.answer_after_hours, set: { agent_active: true, answer_after_hours: true } },
                { label: 'לפי שעות פעילות', active: state.agent_active && !state.answer_after_hours, set: { agent_active: true, answer_after_hours: false } },
                { label: 'כבוי', active: !state.agent_active, set: { agent_active: false } },
              ].map(m => (
                <button key={m.label}
                        style={{ ...box.btn, ...(m.active ? { borderColor: 'var(--accent)', color: 'var(--accent)', fontWeight: 700 } : {}) }}
                        onClick={() => setState(s => ({ ...s, ...m.set }))}>
                  {m.label}
                </button>
              ))}
            </div>
            <label style={box.check}>
              <input type="checkbox" checked={state.followup_enabled} onChange={e => setState(s => ({ ...s, followup_enabled: e.target.checked }))} />
              פולו-אפ אוטומטי אחרי
              <input type="number" min="1" max="14" style={{ ...box.timeInput, width: 52, textAlign: 'center' }}
                     value={state.followup_delay_days}
                     onChange={e => setState(s => ({ ...s, followup_delay_days: e.target.value }))} />
              ימים
            </label>
            <textarea rows={2} style={{ ...box.input, resize: 'vertical', marginTop: 6 }} value={state.followup_message}
                      placeholder="נוסח הפולו-אפ (ריק = ברירת מחדל)"
                      onChange={e => setState(s => ({ ...s, followup_message: e.target.value }))} />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
            <button style={box.btn} onClick={onClose}>ביטול</button>
            <button style={box.btnPrimary} onClick={save} disabled={saving}>{saving ? 'שומר…' : 'שמירת מדיניות'}</button>
          </div>
        </>}
      </div>
    </div>
  )
}
