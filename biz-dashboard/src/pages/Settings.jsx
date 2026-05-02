import { useEffect, useState } from 'react'
import { fetchBusinessProfile, saveBusinessProfile } from '../lib/supabase'

// ── Chip selector (single or multi) ─────────────────────────────────────────
function ChipSelect({ options, value, onChange, multi = false, max = 2 }) {
  function toggle(v) {
    if (!multi) {
      onChange(v)
      return
    }
    const arr = Array.isArray(value) ? value : []
    if (arr.includes(v)) {
      onChange(arr.filter(x => x !== v))
    } else if (arr.length < max) {
      onChange([...arr, v])
    }
  }

  function isSelected(v) {
    return multi ? (Array.isArray(value) && value.includes(v)) : value === v
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          onClick={() => toggle(o.value)}
          style={{
            padding: '6px 14px',
            borderRadius: 20,
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.12s',
            border: isSelected(o.value)
              ? '1.5px solid var(--accent)'
              : '1.5px solid var(--border)',
            background: isSelected(o.value)
              ? 'var(--accent-dim)'
              : 'var(--surface)',
            color: isSelected(o.value)
              ? 'var(--accent-txt)'
              : 'var(--text-muted)',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ── Toggle (pill switch) ─────────────────────────────────────────────────────
function Toggle({ checked, onChange }) {
  return (
    <div
      onClick={() => onChange(!checked)}
      style={{
        width: 44,
        height: 24,
        borderRadius: 12,
        background: checked ? 'var(--accent)' : 'var(--border)',
        position: 'relative',
        cursor: 'pointer',
        flexShrink: 0,
        transition: 'background 0.2s',
      }}
    >
      <div style={{
        position: 'absolute',
        top: 3,
        right: checked ? 3 : 'auto',
        left: checked ? 'auto' : 3,
        width: 18,
        height: 18,
        borderRadius: '50%',
        background: '#fff',
        boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
        transition: 'all 0.2s',
      }} />
    </div>
  )
}

// ── Field label + row ────────────────────────────────────────────────────────
function FieldRow({ label, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>{label}</div>
      {children}
    </div>
  )
}

function ToggleRow({ label, checked, onChange }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
      <span style={{ fontSize: 13, color: 'var(--text)' }}>{label}</span>
      <Toggle checked={!!checked} onChange={onChange} />
    </div>
  )
}

// ── Constants ────────────────────────────────────────────────────────────────
const DAYS = [
  { key: 'sun', label: 'ראשון' },
  { key: 'mon', label: 'שני' },
  { key: 'tue', label: 'שלישי' },
  { key: 'wed', label: 'רביעי' },
  { key: 'thu', label: 'חמישי' },
  { key: 'fri', label: 'שישי' },
  { key: 'sat', label: 'שבת' },
]

const DEFAULT_HOURS = Object.fromEntries(
  DAYS.map(d => [d.key, { active: d.key !== 'sat', from: '09:00', to: '18:00' }])
)

const AGENT_MODE_OPTIONS  = [{ value: 'sales', label: 'מכירות' }, { value: 'support', label: 'תמיכה' }, { value: 'hybrid', label: 'היברידי' }]
const CTA_GOAL_OPTIONS    = [
  { value: 'book_appointment', label: 'קביעת פגישה' },
  { value: 'book_call',        label: 'תיאום שיחה' },
  { value: 'get_quote',        label: 'קבלת הצעת מחיר' },
  { value: 'make_purchase',    label: 'רכישה' },
  { value: 'book_table',       label: 'הזמנת שולחן' },
  { value: 'leave_details',    label: 'השארת פרטים' },
  { value: 'support_only',     label: 'תמיכה בלבד' },
]
const PUSH_SPEED_OPTIONS  = [{ value: 'fast', label: 'מהיר' }, { value: 'balanced', label: 'מאוזן' }, { value: 'slow', label: 'איטי' }]
const TONE_OPTIONS        = [{ value: 'warm', label: 'חם' }, { value: 'professional', label: 'מקצועי' }, { value: 'direct', label: 'ישיר' }, { value: 'friendly', label: 'ידידותי' }, { value: 'casual', label: 'קז׳ואל' }]
const ANSWER_LEN_OPTIONS  = [{ value: 'short', label: 'קצר' }, { value: 'medium', label: 'בינוני' }, { value: 'detailed', label: 'מפורט' }]
const EMOJI_OPTIONS       = [{ value: 'none', label: 'ללא' }, { value: 'light', label: 'קלה' }, { value: 'natural', label: 'טבעי' }, { value: 'free', label: 'חופשי' }]

function buildDefaultForm() {
  return {
    agent_mode: 'hybrid',
    cta_goal: 'book_appointment',
    push_speed: 'balanced',
    tone: ['warm'],
    answer_length: 'medium',
    emoji_usage: 'light',
    agent_active: true,
    answer_after_hours: true,
    after_hours_message: '',
    new_contacts_only: false,
    followup_enabled: false,
    followup_delay_days: 3,
    followup_message: '',
    working_hours: DEFAULT_HOURS,
    jewish_holidays: true,
  }
}

function profileToForm(p) {
  if (!p) return buildDefaultForm()
  return {
    agent_mode:           p.agent_mode         ?? 'hybrid',
    cta_goal:             p.cta_goal           ?? 'book_appointment',
    push_speed:           p.push_speed         ?? 'balanced',
    tone:                 p.tone               ?? ['warm'],
    answer_length:        p.answer_length      ?? 'medium',
    emoji_usage:          p.emoji_usage        ?? 'light',
    agent_active:         p.agent_active       ?? true,
    answer_after_hours:   p.answer_after_hours ?? true,
    after_hours_message:  p.after_hours_message ?? '',
    new_contacts_only:    p.new_contacts_only  ?? false,
    followup_enabled:     p.followup_enabled   ?? false,
    followup_delay_days:  p.followup_delay_days ?? 3,
    followup_message:     p.followup_message   ?? '',
    working_hours:        p.working_hours       ?? DEFAULT_HOURS,
    jewish_holidays:      p.jewish_holidays     ?? true,
  }
}

// ── Main component ───────────────────────────────────────────────────────────
export default function Settings({ businessId }) {
  const [form, setForm]     = useState(buildDefaultForm())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [feedback, setFeedback] = useState(null) // 'ok' | 'err'

  useEffect(() => {
    if (!businessId) return
    fetchBusinessProfile(businessId).then(p => {
      setForm(profileToForm(p))
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [businessId])

  function set(key, val) {
    setForm(f => ({ ...f, [key]: val }))
  }

  function setHours(day, field, val) {
    setForm(f => ({
      ...f,
      working_hours: {
        ...f.working_hours,
        [day]: { ...f.working_hours[day], [field]: val },
      },
    }))
  }

  async function handleSave() {
    setSaving(true)
    setFeedback(null)
    try {
      await saveBusinessProfile(businessId, form)
      setFeedback('ok')
    } catch {
      setFeedback('err')
    }
    setSaving(false)
    setTimeout(() => setFeedback(null), 3000)
  }

  if (!businessId) return <div className="empty">לא נמצא עסק</div>
  if (loading)     return <div className="loading">טוען הגדרות...</div>

  const isSupportOnly = form.cta_goal === 'support_only'

  return (
    <div>
      <div className="page-title">הגדרות סוכן / Settings</div>

      {/* ── Section: Agent Purpose ── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-hd">מטרת הסוכן / Agent purpose</div>

        <FieldRow label="מצב סוכן">
          <ChipSelect options={AGENT_MODE_OPTIONS} value={form.agent_mode} onChange={v => set('agent_mode', v)} />
        </FieldRow>

        <FieldRow label="מטרת CTA">
          <ChipSelect options={CTA_GOAL_OPTIONS} value={form.cta_goal} onChange={v => set('cta_goal', v)} />
        </FieldRow>

        {!isSupportOnly && (
          <FieldRow label="מהירות דחיפה">
            <ChipSelect options={PUSH_SPEED_OPTIONS} value={form.push_speed} onChange={v => set('push_speed', v)} />
          </FieldRow>
        )}
      </div>

      {/* ── Section: Style ── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-hd">סגנון / Style</div>

        <FieldRow label="טון (עד 2)">
          <ChipSelect options={TONE_OPTIONS} value={form.tone} onChange={v => set('tone', v)} multi max={2} />
        </FieldRow>

        <FieldRow label="אורך תשובה">
          <ChipSelect options={ANSWER_LEN_OPTIONS} value={form.answer_length} onChange={v => set('answer_length', v)} />
        </FieldRow>

        <FieldRow label="שימוש באמוג׳י">
          <ChipSelect options={EMOJI_OPTIONS} value={form.emoji_usage} onChange={v => set('emoji_usage', v)} />
        </FieldRow>
      </div>

      {/* ── Section: Availability ── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-hd">זמינות / Availability</div>

        <ToggleRow label="סוכן פעיל" checked={form.agent_active} onChange={v => set('agent_active', v)} />
        <ToggleRow label="מענה מחוץ לשעות" checked={form.answer_after_hours} onChange={v => set('answer_after_hours', v)} />

        {!form.answer_after_hours && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 6 }}>הודעה מחוץ לשעות</div>
            <textarea
              className="textarea"
              rows={2}
              dir="rtl"
              placeholder="לדוגמה: אנחנו לא זמינים כרגע. ניצור קשר מחר בבוקר."
              value={form.after_hours_message}
              onChange={e => set('after_hours_message', e.target.value)}
            />
          </div>
        )}

        <ToggleRow label="אנשי קשר חדשים בלבד" checked={form.new_contacts_only} onChange={v => set('new_contacts_only', v)} />
        <ToggleRow label="פולואפ אוטומטי" checked={form.followup_enabled} onChange={v => set('followup_enabled', v)} />

        {form.followup_enabled && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 4 }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 6 }}>ימים עד פולואפ</div>
              <input
                className="input"
                type="number"
                min={1}
                max={30}
                value={form.followup_delay_days}
                onChange={e => set('followup_delay_days', Number(e.target.value))}
                style={{ maxWidth: 100 }}
              />
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 6 }}>הודעת פולואפ</div>
              <textarea
                className="textarea"
                rows={2}
                dir="rtl"
                placeholder="הודעה שתישלח כפולואפ..."
                value={form.followup_message}
                onChange={e => set('followup_message', e.target.value)}
              />
            </div>
          </div>
        )}
      </div>

      {/* ── Section: Working Hours ── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="section-hd">שעות פעילות / Working hours</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
          {DAYS.map(d => {
            const h = form.working_hours?.[d.key] ?? { active: false, from: '09:00', to: '18:00' }
            return (
              <div key={d.key} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <input
                  type="checkbox"
                  checked={!!h.active}
                  onChange={e => setHours(d.key, 'active', e.target.checked)}
                  style={{ accentColor: 'var(--accent)', width: 16, height: 16, flexShrink: 0 }}
                />
                <span style={{ fontSize: 13, width: 52, flexShrink: 0, color: h.active ? 'var(--text)' : 'var(--text-muted)' }}>
                  {d.label}
                </span>
                {h.active ? (
                  <>
                    <input
                      type="time"
                      className="input"
                      value={h.from}
                      onChange={e => setHours(d.key, 'from', e.target.value)}
                      style={{ maxWidth: 110 }}
                    />
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>עד</span>
                    <input
                      type="time"
                      className="input"
                      value={h.to}
                      onChange={e => setHours(d.key, 'to', e.target.value)}
                      style={{ maxWidth: 110 }}
                    />
                  </>
                ) : (
                  <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>סגור</span>
                )}
              </div>
            )
          })}
        </div>

        <ToggleRow label="חגי ישראל — סגור אוטומטית" checked={form.jewish_holidays} onChange={v => set('jewish_holidays', v)} />
      </div>

      {/* ── Save bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'שומר...' : 'שמור הגדרות'}
        </button>
        {feedback === 'ok' && (
          <span style={{ fontSize: 13, color: 'var(--accent)', fontWeight: 600 }}>✓ נשמר בהצלחה</span>
        )}
        {feedback === 'err' && (
          <span style={{ fontSize: 13, color: '#dc2626', fontWeight: 600 }}>שגיאה בשמירה — נסה שוב</span>
        )}
      </div>
    </div>
  )
}
