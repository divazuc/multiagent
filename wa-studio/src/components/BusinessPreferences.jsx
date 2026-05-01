import { useState, useEffect } from 'react'
import { logError } from './ErrorBoundary.jsx'

const AGENT_BASE = import.meta.env.VITE_AGENT_URL ?? ''
const API = (path) => AGENT_BASE ? `${AGENT_BASE}${path}` : `/api/agent${path}`

const DAYS = ['ראשון / Sun', 'שני / Mon', 'שלישי / Tue', 'רביעי / Wed', 'חמישי / Thu', 'שישי / Fri', 'שבת / Sat']

const DEFAULT_HOURS = DAYS.map((_, i) => ({ active: i < 5, from: '09:00', to: '18:00' }))

// ── Section wrapper ────────────────────────────────────────────────────────────
function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12, paddingBottom: 6, borderBottom: '1px solid var(--border)' }}>
        {title}
      </div>
      {children}
    </div>
  )
}

// ── Field chip row ─────────────────────────────────────────────────────────────
function ChipGroup({ label, options, value, onChange, multi = false, maxSelect = 99 }) {
  const selected = [].concat(value ?? [])
  function toggle(v) {
    if (multi) {
      if (selected.includes(v)) onChange(selected.filter(s => s !== v))
      else if (selected.length < maxSelect) onChange([...selected, v])
    } else {
      onChange(v)
    }
  }
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {options.map(opt => {
          const sel = multi ? selected.includes(opt.value) : value === opt.value
          return (
            <button
              key={opt.value}
              onClick={() => toggle(opt.value)}
              style={{
                padding: '5px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer',
                border: `1px solid ${sel ? 'var(--accent)' : 'var(--border)'}`,
                background: sel ? 'var(--accent-dim)' : 'var(--surface-2)',
                color: sel ? 'var(--accent)' : 'var(--text-dim)',
                fontWeight: sel ? 600 : 400,
              }}
            >
              {opt.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Working hours mini component ───────────────────────────────────────────────
function HoursEditor({ hours, onChange, jewishHolidays, onJewishHolidays }) {
  function update(i, field, val) {
    onChange(hours.map((h, idx) => idx === i ? { ...h, [field]: val } : h))
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {DAYS.map((day, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 8, background: 'var(--surface)', border: `1px solid ${hours[i]?.active ? 'var(--accent)' : 'var(--border)'}` }}>
          <input type="checkbox" checked={hours[i]?.active ?? false} onChange={e => update(i, 'active', e.target.checked)}
            style={{ cursor: 'pointer', accentColor: 'var(--accent)' }} />
          <span style={{ fontSize: 12, minWidth: 80, color: hours[i]?.active ? 'var(--text)' : 'var(--text-muted)' }}>{day}</span>
          {hours[i]?.active ? (
            <>
              <input type="time" value={hours[i]?.from ?? '09:00'} onChange={e => update(i, 'from', e.target.value)}
                style={{ padding: '3px 6px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, flex: 1 }} />
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>
              <input type="time" value={hours[i]?.to ?? '18:00'} onChange={e => update(i, 'to', e.target.value)}
                style={{ padding: '3px 6px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, flex: 1 }} />
            </>
          ) : (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>סגור / Closed</span>
          )}
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, background: 'var(--surface)', border: '1px solid var(--border)', marginTop: 4 }}>
        <input type="checkbox" checked={jewishHolidays} onChange={e => onJewishHolidays(e.target.checked)}
          style={{ cursor: 'pointer', accentColor: 'var(--accent)' }} />
        <span style={{ fontSize: 12, color: 'var(--text)' }}>✡️ שמור על חגים יהודיים / Observe Jewish holidays</span>
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function BusinessPreferences({ session, profile, onClose, onSaved }) {
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState(null)
  const [success, setSuccess]         = useState(false)

  // Form state — seeded from existing profile
  const [agentMode, setAgentMode]     = useState(profile?.agent_mode ?? 'hybrid')
  const [ctaGoal, setCtaGoal]         = useState(profile?.cta_goal ?? 'book_call')
  const [pushSpeed, setPushSpeed]     = useState(profile?.push_speed ?? 'balanced')
  const [tone, setTone]               = useState([].concat(profile?.persona?.tone ?? ['warm']))
  const [answerLength, setLength]     = useState(profile?.persona?.answer_length ?? 'short')
  const [emojiStyle, setEmoji]        = useState(profile?.persona?.emoji_style ?? 'light')
  const [escalation, setEscalation]   = useState([].concat(profile?.guardrails?.escalation_rules ?? []))
  const [forbiddenClaims, setForbidden] = useState(profile?.guardrails?.forbidden_claims ?? '')
  const [finalNote, setFinalNote]     = useState(profile?.persona?.must_not_miss ?? '')
  const [hours, setHours]             = useState(() => profile?.working_hours?.days ?? DEFAULT_HOURS)
  const [jewishHolidays, setJewish]   = useState(profile?.working_hours?.jewish_holidays ?? true)
  const [followupEnabled, setFollowupEnabled]   = useState(profile?.followup_enabled ?? false)
  const [followupDays, setFollowupDays]         = useState(profile?.followup_delay_days ?? 2)
  const [followupMessage, setFollowupMessage]   = useState(profile?.followup_message ?? 'היי! רק רציתי לבדוק אם יש לך שאלות נוספות 😊')

  async function handleSave() {
    setSaving(true)
    setError(null)
    setSuccess(false)
    try {
      const updates = {
        agent_mode:  agentMode,
        cta_goal:    ctaGoal,
        push_speed:  pushSpeed,
        persona:     { ...(profile?.persona ?? {}), tone, answer_length: answerLength, emoji_style: emojiStyle, must_not_miss: finalNote },
        guardrails:  { ...(profile?.guardrails ?? {}), escalation_rules: escalation, forbidden_claims: forbiddenClaims },
        working_hours:     { days: hours, jewish_holidays: jewishHolidays },
        followup_enabled:  followupEnabled,
        followup_delay_days: Number(followupDays) || 2,
        followup_message:  followupMessage,
      }
      const res = await fetch(API('/business/update'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: session?.business_id, updates }),
      })
      const data = await res.json()
      if (data.status !== 'success') throw new Error(data.message)
      setSuccess(true)
      onSaved?.()
      setTimeout(() => setSuccess(false), 3000)
    } catch (e) {
      logError(e.message, 'business-preferences', e.stack)
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="panel panel-chat" style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Header */}
      <div className="panel-header" style={{ justifyContent: 'space-between' }}>
        <span>⚙️ העדפות עסק / Business Preferences</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
      </div>

      {/* Scrollable form */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 20px 0' }}>

        {error && <div style={{ padding: 10, borderRadius: 6, background: 'var(--error-bg)', color: 'var(--error-text)', fontSize: 12, marginBottom: 16 }}>{error}</div>}
        {success && <div style={{ padding: 10, borderRadius: 6, background: 'rgba(0,168,132,0.15)', color: 'var(--accent)', fontSize: 12, marginBottom: 16 }}>✓ נשמר בהצלחה / Saved successfully</div>}

        <Section title="מטרת הסוכן / Agent purpose">
          <ChipGroup label="מצב / Mode" value={agentMode} onChange={setAgentMode}
            options={[
              { value: 'sales',   label: 'Sales / מכירות' },
              { value: 'support', label: 'Support / תמיכה' },
              { value: 'hybrid',  label: 'Hybrid / היברידי' },
            ]} />
          <ChipGroup label="מטרת CTA / CTA goal" value={ctaGoal} onChange={setCtaGoal}
            options={[
              { value: 'book_appointment', label: 'קביעת תור' },
              { value: 'book_call',        label: 'שיחת היכרות' },
              { value: 'get_quote',        label: 'הצעת מחיר' },
              { value: 'make_purchase',    label: 'רכישה' },
              { value: 'book_table',       label: 'הזמנת מקום' },
              { value: 'leave_details',    label: 'השארת פרטים' },
              { value: 'support_only',     label: 'תמיכה בלבד' },
            ]} />
          {ctaGoal !== 'support_only' && (
            <ChipGroup label="קצב דחיפה / Push speed" value={pushSpeed} onChange={setPushSpeed}
              options={[
                { value: 'fast',     label: 'מהיר / Fast' },
                { value: 'balanced', label: 'מאוזן / Balanced' },
                { value: 'slow',     label: 'איטי / Slow' },
              ]} />
          )}
        </Section>

        <Section title="סגנון ואישיות / Tone & Style">
          <ChipGroup label="טון / Tone (עד 2)" value={tone} onChange={setTone} multi maxSelect={2}
            options={[
              { value: 'warm',         label: 'חמים / Warm' },
              { value: 'professional', label: 'מקצועי / Professional' },
              { value: 'direct',       label: 'ישיר / Direct' },
              { value: 'friendly',     label: 'ידידותי / Friendly' },
              { value: 'casual',       label: "קז'ואל / Casual" },
            ]} />
          <ChipGroup label="אורך תשובה / Reply length" value={answerLength} onChange={setLength}
            options={[
              { value: 'short',    label: 'קצר / Short' },
              { value: 'medium',   label: 'בינוני / Medium' },
              { value: 'detailed', label: 'מפורט / Detailed' },
            ]} />
          <ChipGroup label="אימוג'י / Emoji" value={emojiStyle} onChange={setEmoji}
            options={[
              { value: 'none',    label: 'ללא / None' },
              { value: 'light',   label: 'מועט / Light' },
              { value: 'natural', label: 'טבעי / Natural' },
              { value: 'free',    label: "חופשי / Free" },
            ]} />
        </Section>

        <Section title="כללי הגבלה / Guardrails">
          <ChipGroup label="מתי להעביר לבן אדם / Escalation" value={escalation} onChange={setEscalation} multi
            options={[
              { value: 'high_value',         label: 'לקוח גדול' },
              { value: 'complex_question',   label: 'שאלה מורכבת' },
              { value: 'user_asks',          label: 'הלקוח מבקש' },
              { value: 'repeated_objection', label: 'התנגדות חוזרת' },
              { value: 'book_appointment',   label: 'קביעת פגישה' },
            ]} />
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>מה הסוכן לא יגיד / Forbidden claims</div>
            <textarea value={forbiddenClaims} onChange={e => setForbidden(e.target.value)} rows={3}
              style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13, resize: 'vertical', fontFamily: 'var(--font-sans)', outline: 'none' }} />
          </div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>הוראה חשובה / Final note</div>
            <textarea value={finalNote} onChange={e => setFinalNote(e.target.value)} rows={2}
              style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13, resize: 'vertical', fontFamily: 'var(--font-sans)', outline: 'none' }} />
          </div>
        </Section>

        <Section title="שעות פעילות / Working hours">
          <HoursEditor hours={hours} onChange={setHours} jewishHolidays={jewishHolidays} onJewishHolidays={setJewish} />
        </Section>

        <Section title="מעקב אחר לידים / Lead follow-up">
          {/* Master toggle */}
          <div
            onClick={() => setFollowupEnabled(v => !v)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 14px', borderRadius: 10, cursor: 'pointer', marginBottom: 12,
              border: `2px solid ${followupEnabled ? 'var(--accent)' : 'var(--border)'}`,
              background: followupEnabled ? 'var(--accent-dim)' : 'var(--surface)',
            }}
          >
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, color: followupEnabled ? 'var(--accent)' : 'var(--text)' }}>
                🔁 שלח הודעת מעקב ללידים שלא הגיבו / Send follow-up to silent leads
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                גם אם לא בוצע CTA / Also triggers when no CTA was completed
              </div>
            </div>
            <div style={{ width: 36, height: 20, borderRadius: 10, background: followupEnabled ? 'var(--accent)' : 'var(--surface-3)', position: 'relative', flexShrink: 0, transition: 'background 0.2s' }}>
              <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#fff', position: 'absolute', top: 3, left: followupEnabled ? 18 : 3, transition: 'left 0.2s' }} />
            </div>
          </div>

          {followupEnabled && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingRight: 8, borderRight: '3px solid var(--accent)' }}>
              {/* Delay */}
              <div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
                  שלח לאחר / Send after
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={followupDays}
                    onChange={e => setFollowupDays(e.target.value)}
                    style={{ width: 64, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 14, textAlign: 'center', outline: 'none' }}
                  />
                  <span style={{ fontSize: 13, color: 'var(--text)' }}>ימים של שתיקה / days of silence</span>
                </div>
              </div>

              {/* Message */}
              <div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
                  הודעת המעקב / Follow-up message
                </div>
                <textarea
                  value={followupMessage}
                  onChange={e => setFollowupMessage(e.target.value)}
                  rows={3}
                  dir="rtl"
                  style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13, resize: 'vertical', fontFamily: 'var(--font-sans)', outline: 'none' }}
                />
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  הודעה אחת בלבד — אם אין תגובה, לא נשלחת הודעה נוספת
                </div>
              </div>
            </div>
          )}
        </Section>

        <div style={{ height: 80 }} />
      </div>

      {/* Sticky save footer */}
      <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', background: 'var(--surface)', flexShrink: 0 }}>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{ width: '100%', padding: '11px', borderRadius: 8, border: 'none', background: saving ? 'var(--surface-3)' : 'var(--accent)', color: saving ? 'var(--text-muted)' : '#fff', fontWeight: 700, fontSize: 14, cursor: saving ? 'default' : 'pointer' }}
        >
          {saving ? '...שומר' : '💾 שמור שינויים / Save changes'}
        </button>
      </div>
    </div>
  )
}
