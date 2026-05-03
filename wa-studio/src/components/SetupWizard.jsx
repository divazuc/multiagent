import { useState } from 'react'
import { logError } from './ErrorBoundary.jsx'
import { upcomingHolidays } from '../lib/jewish-holidays.js'
import { BUSINESS_TYPES } from '../lib/faq-by-business-type.js'

const AGENT_BASE = import.meta.env.VITE_AGENT_URL ?? ''
const API = (path) => AGENT_BASE ? `${AGENT_BASE}${path}` : `/api/agent${path}`

// ── FAQ topic options by archetype ────────────────────────────────────────────
const FAQ_TOPICS = {
  service: [
    { value: 'pricing',       label: 'Pricing / תמחור',           icon: '💰' },
    { value: 'availability',  label: 'Availability / זמינות',      icon: '📅' },
    { value: 'how_it_works',  label: 'How it works / איך זה עובד', icon: '⚙️' },
    { value: 'experience',    label: 'Experience / ניסיון',        icon: '🏆' },
    { value: 'service_area',  label: 'Service area / אזור שירות',  icon: '📍' },
    { value: 'cancellation',  label: 'Cancellation / ביטול',       icon: '↩️' },
    { value: 'after_service', label: 'After service / תמיכה',      icon: '🔧' },
    { value: 'contact',       label: 'Contact / יצירת קשר',        icon: '💬' },
  ],
  product: [
    { value: 'menu',      label: 'Menu / תפריט',              icon: '📋' },
    { value: 'pricing',   label: 'Pricing / מחירים',           icon: '💰' },
    { value: 'allergies', label: 'Allergies / אלרגיות',        icon: '🥗' },
    { value: 'hours',     label: 'Opening hours / שעות פתיחה', icon: '🕐' },
    { value: 'location',  label: 'Location / מיקום',           icon: '📍' },
    { value: 'returns',   label: 'Returns / החזרות',           icon: '↩️' },
    { value: 'offers',    label: 'Offers / מבצעים',            icon: '🎁' },
    { value: 'contact',   label: 'Contact / יצירת קשר',        icon: '💬' },
  ],
  booking: [
    { value: 'availability', label: 'Availability / זמינות',       icon: '📅' },
    { value: 'pricing',      label: 'Pricing / מחירים',             icon: '💰' },
    { value: 'preparation',  label: 'Preparation / הכנה',           icon: '🎒' },
    { value: 'group',        label: 'Group bookings / הזמנות קבוצה', icon: '👥' },
    { value: 'cancellation', label: 'Cancellation / ביטול',         icon: '↩️' },
    { value: 'trial',        label: 'Trial / ניסיון',               icon: '✨' },
    { value: 'membership',   label: 'Membership / מנוי',            icon: '🏷️' },
    { value: 'contact',      label: 'Contact / יצירת קשר',          icon: '💬' },
  ],
}

// ── Business category options per archetype ───────────────────────────────────
const ARCHETYPE_CATEGORIES = {
  service: [
    { value: 'cleaning',              label: 'ניקיון / Cleaning',              icon: '🧹', desc: 'ניקיון בית, משרד, פוסט-שיפוץ' },
    { value: 'digital_marketing',     label: 'שיווק דיגיטלי / Digital Marketing', icon: '📱', desc: 'סושיאל, גוגל, קופי, אתרים' },
    { value: 'professional_services', label: 'שירותים מקצועיים / Professional', icon: '💼', desc: 'עו"ד, רו"ח, יועץ מס' },
    { value: 'health_therapy',        label: 'בריאות וטיפול / Health',          icon: '🏥', desc: 'רופא, פסיכולוג, פיזיותרפיסט' },
    { value: 'photography',           label: 'צלם / Photography',               icon: '📷', desc: 'חתונות, משפחות, עסקי' },
    { value: 'web_design',            label: 'בניית אתרים / Web Design',        icon: '💻', desc: 'אתרים, עיצוב גרפי, לוגו' },
  ],
  booking: [
    { value: 'gym',        label: 'חדר כושר / Gym & Studio', icon: '💪', desc: 'פיטנס, יוגה, פילאטיס' },
    { value: 'nail_salon', label: 'ציפורניים / Nails',        icon: '💅', desc: 'מניקור, פדיקור, ג\'ל' },
    { value: 'massage_spa',label: 'עיסוי וספא / Massage',    icon: '💆', desc: 'עיסוי, רפלקסולוגיה, ספא' },
    { value: 'hair_salon', label: 'מספרה / Hair Salon',       icon: '✂️', desc: 'תספורת, צביעה, החלקה' },
  ],
  product: [
    { value: 'restaurant', label: 'מסעדה / Restaurant',       icon: '🍽️', desc: 'מסעדה, קפה, קייטרינג' },
  ],
}

const GENERAL_OPTION = { value: 'general', label: 'כללי / General', icon: '⚡', desc: 'שאלות כלליות לסוג העסק' }

// ── Stage definitions ─────────────────────────────────────────────────────────
const STAGES = [
  {
    key: 'business_details',
    title: 'קצת פרטים עליך / A bit about you',
    subtitle: 'כדי שהסוכן ידע מי אתה ואיך ליצור איתך קשר',
    type: 'details',
  },
  {
    key: 'business_type',
    title: 'סוג העסק / Business type',
    type: 'single',
    options: [
      { value: 'service', label: 'Service / שירות', desc: 'ניקיון, תיקונים, ייעוץ, משפטי, בנייה', icon: '🔧' },
      { value: 'product', label: 'Product / מוצר',  desc: 'מסעדה, קפה, חנות אינטרנטית, קמעונאות', icon: '🛍️' },
      { value: 'booking', label: 'Booking / הזמנה', desc: 'חדר כושר, ציפורניים, מספרה, קליניקה',   icon: '📅' },
    ],
  },
  {
    key: 'business_category',
    title: 'סוג עסק ספציפי / Specific business type',
    subtitle: 'מסייע להתאים שאלות FAQ רלוונטיות לעסק שלך',
    type: 'single',
    dynamic: (draft) => {
      const cats = ARCHETYPE_CATEGORIES[draft?.archetype ?? 'service'] ?? []
      return [...cats, GENERAL_OPTION]
    },
  },
  {
    key: 'faq_topics',
    title: 'על מה לקוחות בדרך כלל שואלים? / What do leads ask about?',
    subtitle: 'בחר הכל שרלוונטי / Pick all that apply',
    type: 'multi',
    max: 8,
    dynamic: (draft) => FAQ_TOPICS[draft?.archetype ?? 'service'],
  },
  {
    key: 'cta_goal',
    title: 'מה הפעולה שאתה רוצה שהלקוח יעשה? / What action should leads take?',
    type: 'single',
    options: [
      { value: 'book_appointment', label: 'Book appointment / קביעת תור', icon: '📅' },
      { value: 'book_call',        label: 'Book a call / שיחת היכרות',    icon: '📞' },
      { value: 'get_quote',        label: 'Get a quote / קבלת הצעת מחיר', icon: '📋' },
      { value: 'make_purchase',    label: 'Purchase / רכישה',             icon: '🛒' },
      { value: 'book_table',       label: 'Book a table / הזמנת מקום',    icon: '🍽️' },
      { value: 'leave_details',    label: 'Leave details / השארת פרטים',  icon: '📝' },
      { value: 'support_only',     label: 'Support only / תמיכה בלבד',    icon: '💬' },
    ],
  },
  {
    key: 'push_speed',
    title: 'באיזה קצב הסוכן ידחף לעבר המטרה? / How fast should the agent push?',
    type: 'single',
    skip: (draft) => draft?.cta_goal === 'support_only',
    options: [
      { value: 'fast',     label: 'Fast / מהיר',       desc: 'CTA תוך 2–3 הודעות',        icon: '⚡' },
      { value: 'balanced', label: 'Balanced / מאוזן',   desc: 'כשירות קודם, אז דחיפה',     icon: '⚖️' },
      { value: 'slow',     label: 'Slow / איטי',        desc: 'בניית אמון ללא לחץ',        icon: '🌱' },
    ],
  },
  {
    key: 'tone',
    title: 'איך הסוכן צריך להישמע? / How should the agent sound?',
    subtitle: 'עד 2 בחירות / Pick up to 2',
    type: 'multi',
    max: 2,
    options: [
      { value: 'warm',         label: 'Warm / חמים',           icon: '☀️' },
      { value: 'professional', label: 'Professional / מקצועי',  icon: '👔' },
      { value: 'direct',       label: 'Direct / ישיר',          icon: '🎯' },
      { value: 'friendly',     label: 'Friendly / ידידותי',     icon: '😊' },
      { value: 'casual',       label: 'Casual / קז\'ואל',       icon: '😎' },
    ],
  },
  {
    key: 'response_length',
    title: 'אורך תשובות מועדף / Preferred reply length',
    type: 'single',
    options: [
      { value: 'short',    label: 'Short / קצר',     desc: '1–2 משפטים',  icon: '⚡' },
      { value: 'medium',   label: 'Medium / בינוני', desc: '2–3 משפטים',  icon: '📝' },
      { value: 'detailed', label: 'Detailed / מפורט', desc: '3–5 משפטים', icon: '📄' },
    ],
  },
  {
    key: 'emoji_usage',
    title: 'שימוש באימוג\'י / Emoji usage',
    type: 'single',
    options: [
      { value: 'none',    label: 'None / ללא',       desc: 'טקסט נקי',          icon: '🚫' },
      { value: 'light',   label: 'Light / מועט',     desc: 'מדי פעם',            icon: '✨' },
      { value: 'natural', label: 'Natural / טבעי',   desc: 'כשזה מתאים',         icon: '😊' },
      { value: 'free',    label: 'Free / חופשי',     desc: 'הרבה אימוג\'י',      icon: '🎉' },
    ],
  },
  {
    key: 'escalation',
    title: 'מתי להעביר לבן אדם? / When to hand off to a human?',
    subtitle: 'בחר הכל שרלוונטי / Pick all that apply',
    type: 'multi',
    max: 99,
    options: [
      { value: 'high_value',         label: 'High-value lead / לקוח גדול',             icon: '💎' },
      { value: 'complex_question',   label: 'Complex question / שאלה מורכבת',          icon: '🧩' },
      { value: 'user_asks',          label: 'User asks for human / הלקוח מבקש אדם',    icon: '🙋' },
      { value: 'repeated_objection', label: 'Repeated objection / התנגדות חוזרת',      icon: '🔄' },
      { value: 'book_appointment',   label: 'Book a call/appointment / קביעת פגישה',   icon: '📞' },
      { value: 'other',              label: 'Other / אחר — specify below',              icon: '✏️' },
    ],
  },
  {
    key: 'escalation_other',
    title: 'פרט מתי עוד יש להעביר לבן אדם / Specify other escalation cases',
    subtitle: 'אופציונלי — רק אם בחרת "אחר" / Only if you selected "Other"',
    type: 'text',
    placeholder: 'לדוגמה: כשהלקוח שואל על מחיר מעל ₪10,000',
    skip: (draft) => !([].concat(draft?.escalation ?? [])).includes('other'),
  },
  {
    key: 'faq_examples',
    title: 'שאלות נפוצות / Common questions',
    subtitle: 'אופציונלי — ניתן להוסיף עוד שאלות בהמשך בלשונית FAQ',
    type: 'faq_pairs',
  },
  {
    key: 'objections',
    title: 'התנגדויות נפוצות / Common objections',
    subtitle: 'אופציונלי — איך אתה מגיב',
    type: 'text',
    placeholder: '"יקר מדי" → האיכות מדברת בעד עצמה, יש לנו ניסיון חינם\n\n"אחזור אליך" → כמובן! אשלח לך כמה עבודות קודמות בינתיים',
  },
  {
    key: 'forbidden_claims',
    title: 'מה הסוכן לא יגיד? / What should the agent never say?',
    subtitle: 'אופציונלי',
    type: 'text',
    placeholder: 'אל תבטיח זמינות ביום אותו יום ללא בדיקה\nאל תצטט מחירים מדויקים ללא ראיית העבודה',
  },
  {
    key: 'final_note',
    title: 'הוראה אחרונה חשובה / One final instruction',
    subtitle: 'אופציונלי — הדבר החשוב ביותר שהסוכן לא יפספס',
    type: 'text',
    placeholder: 'תמיד לסיים עם צעד הבא ספציפי, אף פעם לא להשאיר את השיחה פתוחה',
  },
  {
    key: 'working_hours',
    title: 'שעות פעילות / Business hours',
    subtitle: 'סמן ✓ לימים שאתה עובד בהם / Check the days you work',
    type: 'working_hours',
  },
  {
    key: 'agent_availability',
    title: 'מתי הסוכן יענה? / When should the agent respond?',
    subtitle: 'הגדר את תנאי הפעלת הסוכן / Set activation conditions',
    type: 'availability',
  },
  {
    key: 'confirm_and_commit',
    title: '🚀 מוכן להפעיל את הסוכן? / Ready to activate?',
    type: 'confirm',
  },
]

const PROGRESS_KEYS = STAGES.map(s => s.key)

// ── Component ─────────────────────────────────────────────────────────────────

export default function SetupWizard({ session, draft, sending, onSend, onRefreshDB, onCommitted, onStartDemo }) {
  const [selections, setSelections] = useState([])
  const [textValue, setTextValue]   = useState('')
  const [saving, setSaving]         = useState(false)
  const [error, setError]           = useState(null)
  const [localStage, setLocalStage] = useState(null) // tracks stage locally after each save

  // Normalise legacy stage names → new wizard stages
  const rawStage = localStage ?? session?.current_setup_stage ?? session?.current_stage ?? 'business_type'
  const LEGACY_MAP = {
    'collect_business_model': 'business_details',
    'setup_start':            'business_details',
    'start':                  'business_details',
    'collect_agent_mode':     'business_details',
    'business_type':          'business_type', // keep valid — existing sessions mid-flow
  }
  const currentStage = LEGACY_MAP[rawStage] ?? rawStage

  // Find current stage config — fall back to business_type if unknown
  const stageConfig = STAGES.find(s => s.key === currentStage) ?? STAGES[0]

  // Resolve dynamic options
  const options = stageConfig?.dynamic
    ? stageConfig.dynamic(draft)
    : stageConfig?.options ?? []

  // Auto-skip logic
  const shouldSkip = stageConfig?.skip?.(draft)

  const progressIdx = PROGRESS_KEYS.indexOf(currentStage)
  const progress    = progressIdx >= 0 ? Math.round((progressIdx / (PROGRESS_KEYS.length - 1)) * 100) : 0

  function toggleOption(value) {
    if (stageConfig?.type === 'multi') {
      const max = stageConfig.max ?? 8
      setSelections(prev =>
        prev.includes(value)
          ? prev.filter(v => v !== value)
          : prev.length < max ? [...prev, value] : prev
      )
    } else {
      setSelections([value])
    }
  }

  async function handleSave(valueOverride) {
    const value = valueOverride ?? (
      stageConfig?.type === 'text'          ? (textValue.trim() || null) :
      stageConfig?.type === 'faq_pairs'     ? faqPairs.filter(p => p.q.trim()) :
      stageConfig?.type === 'working_hours' ? { days: hours, jewish_holidays: jewishHolidays } :
      stageConfig?.type === 'details'       ? details :
      stageConfig?.type === 'availability'  ? availability :
      stageConfig?.type === 'single'        ? (selections[0] ?? null) :
      selections  // multi stays as array
    )
    if (!value && stageConfig?.type !== 'text') return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(API('/setup/save'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session.session_id, stage: currentStage, value }),
      })
      const data = await res.json()
      if (data.status !== 'success') throw new Error(data.message)
      setSelections([])
      setTextValue('')
      if (data.next_stage) setLocalStage(data.next_stage)
      onRefreshDB?.()
    } catch (e) {
      logError(e.message, 'setup/save', e.stack)
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleCommit() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(API('/setup/commit'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session.session_id, business_id: session.business_id }),
      })
      const data = await res.json()
      if (data.status !== 'success') throw new Error(data.message)
      onRefreshDB?.()
      onCommitted?.()  // triggers session list refresh in App so setup_completed flips
    } catch (e) {
      logError(e.message, 'setup/commit', e.stack)
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  // Business details state
  const [details, setDetails] = useState(() => ({
    business_name:     draft?.business_details?.business_name     ?? '',
    contact_name:      draft?.business_details?.contact_name      ?? '',
    contact_phone:     draft?.business_details?.contact_phone     ?? '',
    contact_email:     draft?.business_details?.contact_email     ?? '',
    business_category: draft?.business_details?.business_category ?? '',
  }))

  // Agent availability state
  const [availability, setAvailability] = useState(() => ({
    agent_active:                 draft?.agent_availability?.agent_active                 ?? true,
    answer_after_hours:           draft?.agent_availability?.answer_after_hours           ?? true,
    after_hours_message:          draft?.agent_availability?.after_hours_message          ?? 'תודה שפנית! 😊 אנחנו לא זמינים כרגע. נחזור אליך בהקדם בשעות הפעילות שלנו.',
    new_contacts_only:            draft?.agent_availability?.new_contacts_only            ?? false,
    skip_initiated_conversations: draft?.agent_availability?.skip_initiated_conversations ?? true,
    followup_enabled:             draft?.agent_availability?.followup_enabled             ?? false,
    followup_delay_days:          draft?.agent_availability?.followup_delay_days          ?? 2,
    followup_message:             draft?.agent_availability?.followup_message             ?? 'היי! רק רציתי לבדוק אם יש לך שאלות נוספות 😊',
  }))

  // FAQ pairs state
  const [faqPairs, setFaqPairs] = useState([{ q: '', a: '' }])

  // Working hours state
  const DAYS = ['ראשון / Sun', 'שני / Mon', 'שלישי / Tue', 'רביעי / Wed', 'חמישי / Thu', 'שישי / Fri', 'שבת / Sat']
  const [hours, setHours] = useState(() =>
    DAYS.map((_, i) => ({ active: i < 5, from: '09:00', to: '18:00' }))
  )
  const [jewishHolidays, setJewishHolidays] = useState(true)

  const canContinue = ['text', 'faq_pairs', 'working_hours', 'availability', 'details'].includes(stageConfig?.type)
    ? true
    : selections.length > 0

  return (
    <div className="panel panel-chat" style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>

      {/* Header + progress */}
      <div className="panel-header" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, padding: '12px 16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>Business Setup</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {progressIdx + 1} / {PROGRESS_KEYS.length}
          </span>
        </div>
        <div style={{ height: 3, background: 'var(--surface-3)', borderRadius: 2 }}>
          <div style={{ height: '100%', width: `${progress}%`, background: 'var(--accent)', borderRadius: 2, transition: 'width 0.4s ease' }} />
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {error && (
          <div style={{ padding: 10, borderRadius: 6, background: 'var(--error-bg)', color: 'var(--error-text)', fontSize: 12 }}>
            {error}
          </div>
        )}

        {shouldSkip ? (
          <SkipNotice label={stageConfig?.title} onSkip={() => handleSave(null)} saving={saving} />
        ) : stageConfig?.type === 'confirm' ? (
          <ConfirmStage draft={draft} onCommit={handleCommit} onStartDemo={onStartDemo} saving={saving} />
        ) : stageConfig?.type === 'details' ? (
          <DetailsStage config={stageConfig} value={details} onChange={setDetails} />
        ) : stageConfig?.type === 'availability' ? (
          <AvailabilityStage config={stageConfig} value={availability} onChange={setAvailability} />
        ) : stageConfig?.type === 'faq_pairs' ? (
          <FaqPairsStage config={stageConfig} pairs={faqPairs} onChange={setFaqPairs} />
        ) : stageConfig?.type === 'working_hours' ? (
          <WorkingHoursStage days={DAYS} hours={hours} onChange={setHours} jewishHolidays={jewishHolidays} onJewishHolidays={setJewishHolidays} />
        ) : stageConfig?.type === 'text' ? (
          <TextStage config={stageConfig} value={textValue} onChange={setTextValue} />
        ) : (
          <OptionStage
            config={stageConfig}
            options={options}
            selections={selections}
            onToggle={toggleOption}
          />
        )}
      </div>

      {/* Footer */}
      {!shouldSkip && stageConfig?.type !== 'confirm' && (
        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8 }}>
          {(stageConfig?.type === 'text' || stageConfig?.type === 'faq_pairs') && (
            <button onClick={() => handleSave(null)} disabled={saving} style={btnStyle('ghost')}>
              דלג / Skip
            </button>
          )}
          <button
            onClick={() => handleSave()}
            disabled={(!canContinue && stageConfig?.type !== 'text') || saving}
            style={btnStyle(canContinue || stageConfig?.type === 'text' ? 'primary' : 'disabled')}
          >
            {saving ? '...שומר' : 'המשך ←'}
          </button>
        </div>
      )}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function OptionStage({ config, options, selections, onToggle }) {
  return (
    <>
      <div>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', lineHeight: 1.4 }}>{config.title}</div>
        {config.subtitle && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{config.subtitle}</div>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {(options ?? []).map(opt => {
          const selected = selections.includes(opt.value)
          return (
            <div
              key={opt.value}
              onClick={() => onToggle(opt.value)}
              style={{
                padding: '11px 14px',
                borderRadius: 10,
                cursor: 'pointer',
                border: `2px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
                background: selected ? 'var(--accent-dim)' : 'var(--surface)',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                transition: 'all 0.15s',
                userSelect: 'none',
              }}
            >
              <span style={{ fontSize: 20, flexShrink: 0 }}>{opt.icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: selected ? 'var(--accent)' : 'var(--text)' }}>
                  {opt.label}
                </div>
                {opt.desc && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {opt.desc}
                  </div>
                )}
              </div>
              {selected && <span style={{ color: 'var(--accent)', fontSize: 14, flexShrink: 0 }}>✓</span>}
            </div>
          )
        })}
      </div>
    </>
  )
}

function TextStage({ config, value, onChange }) {
  return (
    <>
      <div>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', lineHeight: 1.4 }}>{config.title}</div>
        {config.subtitle && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{config.subtitle}</div>}
      </div>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={config.placeholder}
        rows={7}
        style={{
          width: '100%', padding: 12, borderRadius: 8,
          border: '1px solid var(--border)', background: 'var(--surface)',
          color: 'var(--text)', fontSize: 13, resize: 'vertical',
          fontFamily: 'var(--font-sans)', lineHeight: 1.6, outline: 'none',
        }}
      />
    </>
  )
}

function ConfirmStage({ draft, onCommit, onStartDemo, saving }) {
  const lines = [
    draft?.archetype       && `סוג עסק: ${draft.archetype}`,
    draft?.agent_mode      && `מצב סוכן: ${draft.agent_mode}`,
    draft?.cta_goal        && `מטרת CTA: ${[].concat(draft.cta_goal)[0]?.replace?.(/_/g, ' ') ?? draft.cta_goal}`,
    draft?.push_speed      && `קצב דחיפה: ${draft.push_speed}`,
    draft?.persona?.tone   && `טון: ${[].concat(draft.persona.tone).join(', ')}`,
    draft?.faq_topics?.length && `נושאי FAQ: ${draft.faq_topics.length} נבחרו`,
  ].filter(Boolean)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>✅ ההגדרות מוכנות!</div>

      <div style={{ background: 'var(--surface)', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {lines.map((l, i) => (
          <div key={i} style={{ fontSize: 13, color: 'var(--text-dim)', display: 'flex', gap: 8 }}>
            <span style={{ color: 'var(--accent)' }}>✓</span> {l}
          </div>
        ))}
      </div>

      {/* Recommended: Demo */}
      <div style={{ background: 'var(--accent-dim)', border: '1px solid var(--accent)', borderRadius: 12, padding: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent)', marginBottom: 6 }}>
          🎙️ שלב הלמידה — מומלץ מאוד
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.6 }}>
          ענה על 12 שאלות קצרות ו-Claude ילמד לדבר בדיוק כמוך.
          ללא שלב זה הסוכן יענה בסגנון כללי — יעבוד, אבל לא יישמע כמוך.
        </div>
        <button
          onClick={onStartDemo}
          disabled={saving}
          style={{ ...btnStyle('primary'), padding: '12px 20px', fontSize: 13, width: '100%' }}
        >
          {saving ? '...' : '🎙️ התחל שלב למידה'}
        </button>
      </div>

      {/* Skip to live */}
      <button
        onClick={onCommit}
        disabled={saving}
        style={{ ...btnStyle('ghost'), fontSize: 12, padding: '8px 16px' }}
      >
        דלג → עבור ישירות ללייב (סגנון כללי)
      </button>
    </div>
  )
}

function SkipNotice({ label, onSkip, saving }) {
  return (
    <div style={{ textAlign: 'center', paddingTop: 32, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
      <div style={{ fontSize: 14, color: 'var(--text-muted)' }}>שלב זה לא נדרש עבור הגדרה זו / This step is not needed.</div>
      <button onClick={onSkip} disabled={saving} style={btnStyle('primary')}>
        המשך ← / Continue →
      </button>
    </div>
  )
}

// ── FAQ Pairs stage ───────────────────────────────────────────────────────────
function FaqPairsStage({ config, pairs, onChange }) {
  function update(i, field, val) {
    const next = pairs.map((p, idx) => idx === i ? { ...p, [field]: val } : p)
    onChange(next)
  }
  function addPair() { onChange([...pairs, { q: '', a: '' }]) }
  function removePair(i) { onChange(pairs.filter((_, idx) => idx !== i)) }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>{config.title}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{config.subtitle}</div>
        <div style={{ fontSize: 11, color: 'var(--accent)', marginTop: 6 }}>
          💡 ניתן להוסיף עוד שאלות אחרי ההגדרה בלשונית FAQ / You can add more later in the FAQ tab
        </div>
      </div>
      {pairs.map((pair, i) => (
        <div key={i} style={{ background: 'var(--surface)', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8, border: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>שאלה {i + 1} / Q{i + 1}</span>
            {pairs.length > 1 && (
              <button onClick={() => removePair(i)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14 }}>✕</button>
            )}
          </div>
          <input
            value={pair.q}
            onChange={e => update(i, 'q', e.target.value)}
            placeholder="השאלה / Question"
            style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13, outline: 'none' }}
          />
          <textarea
            value={pair.a}
            onChange={e => update(i, 'a', e.target.value)}
            placeholder="התשובה שלך / Your answer"
            rows={2}
            style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13, outline: 'none', resize: 'vertical', fontFamily: 'var(--font-sans)' }}
          />
        </div>
      ))}
      <button onClick={addPair} style={{ padding: '8px', borderRadius: 8, border: '1px dashed var(--border)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12 }}>
        + הוסף שאלה / Add question
      </button>
    </div>
  )
}

// ── Working Hours stage ───────────────────────────────────────────────────────
function WorkingHoursStage({ days, hours, onChange, jewishHolidays, onJewishHolidays }) {
  function update(i, field, val) {
    onChange(hours.map((h, idx) => idx === i ? { ...h, [field]: val } : h))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>שעות פעילות / Business hours</div>

      {days.map((day, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 8, background: 'var(--surface)', border: `1px solid ${hours[i].active ? 'var(--accent)' : 'var(--border)'}` }}>
          {/* Active toggle */}
          <input
            type="checkbox"
            checked={hours[i].active}
            onChange={e => update(i, 'active', e.target.checked)}
            style={{ width: 16, height: 16, cursor: 'pointer', accentColor: 'var(--accent)' }}
          />
          {/* Day name */}
          <span style={{ fontSize: 12, fontWeight: 600, color: hours[i].active ? 'var(--text)' : 'var(--text-muted)', minWidth: 80 }}>{day}</span>
          {/* Hours */}
          {hours[i].active ? (
            <>
              <input
                type="time"
                value={hours[i].from}
                onChange={e => update(i, 'from', e.target.value)}
                style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, flex: 1 }}
              />
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>
              <input
                type="time"
                value={hours[i].to}
                onChange={e => update(i, 'to', e.target.value)}
                style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, flex: 1 }}
              />
            </>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>סגור / Closed</span>
          )}
        </div>
      ))}

      {/* Jewish holidays */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 8, background: 'var(--surface)', border: `1px solid ${jewishHolidays ? 'var(--accent)' : 'var(--border)'}`, marginTop: 4 }}>
        <input
          type="checkbox"
          checked={jewishHolidays}
          onChange={e => onJewishHolidays(e.target.checked)}
          style={{ width: 16, height: 16, cursor: 'pointer', accentColor: 'var(--accent)' }}
        />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>✡️ סגור בחגים יהודיים / Closed on Jewish holidays</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
            הסוכן ישלח הודעת היעדרות בימי יום-טוב / Agent sends out-of-hours reply on Yom Tov
          </div>
          {jewishHolidays && upcomingHolidays(3).length > 0 && (
            <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {upcomingHolidays(3).map(h => (
                <div key={h.date} style={{ fontSize: 11, color: 'var(--accent)' }}>
                  📅 {h.date} — {h.name}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Business Details stage ────────────────────────────────────────────────────
function DetailsStage({ config, value, onChange }) {
  const field = (key, label, placeholder, type = 'text') => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</label>
      <input
        type={type}
        value={value[key]}
        onChange={e => onChange(prev => ({ ...prev, [key]: e.target.value }))}
        placeholder={placeholder}
        style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13, outline: 'none' }}
      />
    </div>
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', lineHeight: 1.4 }}>{config.title}</div>
        {config.subtitle && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{config.subtitle}</div>}
      </div>
      {field('business_name', 'שם העסק / Business name', 'TechPro IT')}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>קטגוריה / Business type</label>
        <select
          value={value.business_category}
          onChange={e => onChange(prev => ({ ...prev, business_category: e.target.value }))}
          style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13, outline: 'none' }}
        >
          <option value="">— בחר קטגוריה / Select category —</option>
          {Object.entries(BUSINESS_TYPES).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </div>
      {field('contact_name',  'השם שלך (פרטי בלבד) / Your first name', 'דנה / Dana')}
      {field('contact_phone', 'מספר וואטסאפ עסקי / WhatsApp number', '+972501234567', 'tel')}
      {field('contact_email', 'אימייל עסקי / Business email', 'hello@mybusiness.com', 'email')}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: -4 }}>
        * האימייל לשימוש פנימי בלבד — דוחות ועדכונים עתידיים
      </div>
    </div>
  )
}

// ── Agent Availability stage ──────────────────────────────────────────────────
function AvailabilityStage({ config, value, onChange }) {
  const set = (key, val) => onChange(prev => ({ ...prev, [key]: val }))

  const ToggleRow = ({ field, label, desc, icon }) => (
    <div
      onClick={() => set(field, !value[field])}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
        borderRadius: 10, cursor: 'pointer',
        border: `2px solid ${value[field] ? 'var(--accent)' : 'var(--border)'}`,
        background: value[field] ? 'var(--accent-dim)' : 'var(--surface)',
        transition: 'all 0.15s', userSelect: 'none',
      }}
    >
      <span style={{ fontSize: 20, flexShrink: 0 }}>{icon}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: value[field] ? 'var(--accent)' : 'var(--text)' }}>{label}</div>
        {desc && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{desc}</div>}
      </div>
      <div style={{
        width: 36, height: 20, borderRadius: 10, flexShrink: 0,
        background: value[field] ? 'var(--accent)' : 'var(--surface-3)',
        position: 'relative', transition: 'background 0.2s',
      }}>
        <div style={{
          width: 14, height: 14, borderRadius: '50%', background: '#fff',
          position: 'absolute', top: 3, transition: 'left 0.2s',
          left: value[field] ? 18 : 3,
        }} />
      </div>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', lineHeight: 1.4 }}>{config.title}</div>
        {config.subtitle && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{config.subtitle}</div>}
      </div>

      <ToggleRow field="agent_active"                 icon="🟢" label="סוכן פעיל / Agent is active"              desc="ניתן לשנות בכל עת מממשק הניהול / Changeable anytime from studio" />
      <ToggleRow field="answer_after_hours"           icon="🌙" label="ענה גם מחוץ לשעות פעילות / Answer after hours" desc="כבוי = שלח הודעת היעדרות בלבד / Off = send out-of-hours reply only" />

      {!value.answer_after_hours && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingRight: 8, borderRight: '3px solid var(--accent)' }}>
          <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>הודעת היעדרות / After-hours message</label>
          <textarea
            value={value.after_hours_message}
            onChange={e => set('after_hours_message', e.target.value)}
            rows={3}
            style={{ padding: 10, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13, resize: 'vertical', fontFamily: 'var(--font-sans)', outline: 'none' }}
          />
        </div>
      )}

      <ToggleRow field="new_contacts_only"            icon="👤" label="ענה רק לאנשי קשר חדשים / New contacts only"  desc="מספרים שאין להם היסטוריית שיחה / Numbers with no prior conversation" />
      <ToggleRow field="skip_initiated_conversations" icon="↩️" label="דלג על שיחות שאני התחלתי / Skip conversations I started" desc="לא יענה אם העסק שלח הודעה ראשון / Won't reply if business sent first" />
      <ToggleRow field="followup_enabled"             icon="🔁" label="שלח מעקב ללידים שלא הגיבו / Follow-up silent leads" desc="הודעה אחת בלבד אחרי X ימי שתיקה ללא CTA" />

      {value.followup_enabled && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingRight: 8, borderRight: '3px solid var(--accent)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>שלח אחרי / Send after</label>
            <input
              type="number" min={1} max={30}
              value={value.followup_delay_days}
              onChange={e => set('followup_delay_days', Number(e.target.value) || 2)}
              style={{ width: 56, padding: '5px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13, textAlign: 'center', outline: 'none' }}
            />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>ימים / days</span>
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>הודעת המעקב / Follow-up message</label>
            <textarea
              value={value.followup_message}
              onChange={e => set('followup_message', e.target.value)}
              rows={2} dir="rtl"
              style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, resize: 'vertical', fontFamily: 'var(--font-sans)', outline: 'none' }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function btnStyle(variant) {
  const base = { padding: '10px 20px', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer', border: 'none', transition: 'background 0.2s', flex: 1 }
  if (variant === 'primary')  return { ...base, background: 'var(--accent)', color: '#fff' }
  if (variant === 'ghost')    return { ...base, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)', flex: 'none', padding: '10px 16px' }
  if (variant === 'disabled') return { ...base, background: 'var(--surface-3)', color: 'var(--text-muted)', cursor: 'default' }
  return base
}
