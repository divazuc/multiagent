import { useState } from 'react'
import { SETUP_STAGES } from '../lib/presets.js'

// ── Stage definitions ─────────────────────────────────────────────────────────

const STAGE_CONFIG = {
  collect_business_model: {
    question: 'What type of business do you run?',
    type: 'single',
    options: [
      { value: 'service', label: 'Service',  desc: 'Cleaning, repairs, consulting, legal, construction',   icon: '🔧' },
      { value: 'product', label: 'Product',  desc: 'Restaurant, café, online store, retail, spa menu',     icon: '🛍️' },
      { value: 'booking', label: 'Booking',  desc: 'Gym, nail salon, hair salon, physio, dentist, clinic', icon: '📅' },
    ],
  },
  collect_agent_mode: {
    question: "What's the agent's main purpose?",
    type: 'single',
    options: [
      { value: 'sales',   label: 'Sales',   desc: 'Push leads toward booking, purchase, or quote',          icon: '🎯' },
      { value: 'support', label: 'Support', desc: 'Answer questions, handle complaints, provide info',       icon: '💬' },
      { value: 'hybrid',  label: 'Hybrid',  desc: 'Answer first, then gently guide toward conversion',       icon: '⚡' },
    ],
  },
  collect_cta_goal: (draft) => {
    const archetype = draft?.archetype ?? 'service'
    const optionsByArchetype = {
      service: [
        { value: 'book_call',    label: 'Book a call',     icon: '📞' },
        { value: 'get_quote',    label: 'Get a quote',     icon: '📋' },
        { value: 'leave_details',label: 'Leave details',   icon: '📝' },
        { value: 'chat_qualify', label: 'Chat to qualify', icon: '💭' },
      ],
      product: [
        { value: 'purchase',      label: 'Make a purchase',     icon: '🛒' },
        { value: 'book_table',    label: 'Book a table',        icon: '🍽️' },
        { value: 'get_price_list',label: 'Get price list',      icon: '💰' },
        { value: 'leave_details', label: 'Leave details',       icon: '📝' },
      ],
      booking: [
        { value: 'book_appointment', label: 'Book an appointment', icon: '📅' },
        { value: 'book_trial',       label: 'Book a trial session',icon: '✨' },
        { value: 'get_pricing',      label: 'Get pricing info',    icon: '💰' },
        { value: 'leave_details',    label: 'Leave details',       icon: '📝' },
      ],
    }
    return {
      question: 'What is the main action you want leads to take?',
      type: 'single',
      options: optionsByArchetype[archetype] ?? optionsByArchetype.service,
    }
  },
  primary_goal: {
    question: 'What is the main action you want a new lead to take?',
    type: 'single',
    options: [
      { value: 'book_call',    label: 'Book a call',              icon: '📞' },
      { value: 'leave_details',label: 'Leave details',            icon: '📝' },
      { value: 'purchase',     label: 'Make a purchase',          icon: '🛒' },
      { value: 'chat',         label: 'Continue chatting',        icon: '💬' },
    ],
  },
  conversation_priority: {
    question: 'What matters most in the first conversation?',
    type: 'single',
    options: [
      { value: 'understand',  label: 'Understand the need',     icon: '🔍' },
      { value: 'filter',      label: 'Filter irrelevant leads', icon: '🔽' },
      { value: 'close',       label: 'Close quickly',           icon: '⚡' },
      { value: 'inform',      label: 'Give information only',   icon: 'ℹ️' },
    ],
  },
  persona_tone: {
    question: 'How should the agent sound? (pick up to 2)',
    type: 'multi',
    max: 2,
    options: [
      { value: 'warm',         label: 'Warm',         icon: '☀️' },
      { value: 'professional', label: 'Professional',  icon: '👔' },
      { value: 'direct',       label: 'Direct',        icon: '🎯' },
      { value: 'friendly',     label: 'Friendly',      icon: '😊' },
      { value: 'casual',       label: 'Casual',        icon: '😎' },
    ],
  },
  answer_length: {
    question: 'Preferred reply length?',
    type: 'single',
    options: [
      { value: 'short',    label: 'Very short',  desc: '1–2 sentences', icon: '⚡' },
      { value: 'medium',   label: 'Medium',      desc: '2–3 sentences', icon: '📝' },
      { value: 'detailed', label: 'Detailed',    desc: '3–5 sentences', icon: '📄' },
    ],
  },
  emoji_style: {
    question: 'Emoji usage in responses?',
    type: 'single',
    options: [
      { value: 'none',    label: 'None',    desc: 'No emojis',             icon: '🚫' },
      { value: 'light',   label: 'Light',   desc: 'Occasional use',        icon: '✨' },
      { value: 'natural', label: 'Natural', desc: 'When it feels right',   icon: '😊' },
      { value: 'free',    label: 'Free',    desc: 'Emojis everywhere',     icon: '🎉' },
    ],
  },
  escalation_rules: {
    question: 'When should the agent hand off to a human? (pick up to 2)',
    type: 'multi',
    max: 2,
    options: [
      { value: 'high_value',        label: 'High-value lead',       icon: '💎' },
      { value: 'complex_question',  label: 'Complex question',      icon: '🧩' },
      { value: 'user_asks',         label: 'User asks for human',   icon: '🙋' },
      { value: 'repeated_objection',label: 'Repeated objection',    icon: '🔄' },
    ],
  },
}

// Free-text stages — shown as textarea
const FREE_TEXT_STAGES = {
  branch_type_1:    { question: null, placeholder: 'Describe your main services / offerings...' },
  branch_type_2:    { question: null, placeholder: 'What do you need to know before moving forward with a lead?' },
  branch_type_3:    { question: null, placeholder: 'What\'s the first question you usually ask a new lead?' },
  faq:              { question: 'Common questions customers ask (2–3 examples)', placeholder: 'Q: How much does it cost?\nA: Pricing starts from ₪150...' },
  objections:       { question: 'Common objections and how you handle them', placeholder: '"Too expensive" → We offer flexible payment options...' },
  forbidden_claims: { question: 'What should the agent NEVER say or promise?', placeholder: 'Never promise same-day availability...' },
  final_note:       { question: 'One thing the agent must never miss about how you talk to customers', placeholder: 'Always end with a specific next step...' },
}

// Stage display labels for progress bar
const PROGRESS_STAGES = [
  'collect_business_model', 'collect_agent_mode', 'collect_cta_goal',
  'primary_goal', 'conversation_priority',
  'branch_type_1', 'branch_type_2', 'branch_type_3',
  'persona_tone', 'answer_length', 'emoji_style',
  'faq', 'objections', 'forbidden_claims', 'escalation_rules', 'final_note',
  'confirm_and_commit',
]

// ── Component ─────────────────────────────────────────────────────────────────

export default function SetupWizard({ session, draft, sending, onSend }) {
  const [selections, setSelections] = useState([])
  const [textValue, setTextValue]   = useState('')

  const currentStage = session?.current_setup_stage ?? session?.current_stage ?? 'collect_business_model'
  const agentMode    = draft?.agent_mode

  // Resolve stage config (some are functions of draft)
  const rawConfig = STAGE_CONFIG[currentStage]
  const config    = typeof rawConfig === 'function' ? rawConfig(draft) : rawConfig
  const freeText  = FREE_TEXT_STAGES[currentStage]

  const progressIndex = PROGRESS_STAGES.indexOf(currentStage)
  const progress      = progressIndex >= 0 ? Math.round((progressIndex / (PROGRESS_STAGES.length - 1)) * 100) : 0

  // Filter out CTA goal stage for support mode
  const skipStage = currentStage === 'collect_cta_goal' && agentMode === 'support'

  function toggleOption(value) {
    if (config?.type === 'multi') {
      const max = config.max ?? 2
      setSelections(prev =>
        prev.includes(value)
          ? prev.filter(v => v !== value)
          : prev.length < max ? [...prev, value] : prev
      )
    } else {
      setSelections([value])
    }
  }

  function handleContinue() {
    if (sending) return
    const msg = config
      ? selections.join(', ')
      : textValue.trim()
    if (!msg) return
    onSend(msg)
    setSelections([])
    setTextValue('')
  }

  function handleSkip() {
    onSend('skip')
    setSelections([])
    setTextValue('')
  }

  const canContinue = config ? selections.length > 0 : textValue.trim().length > 0

  return (
    <div className="panel panel-chat" style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>

      {/* Header */}
      <div className="panel-header" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, padding: '12px 16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>Business Setup</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{progress}%</span>
        </div>
        {/* Progress bar */}
        <div style={{ height: 3, background: 'var(--surface-3)', borderRadius: 2 }}>
          <div style={{ height: '100%', width: `${progress}%`, background: 'var(--accent)', borderRadius: 2, transition: 'width 0.3s' }} />
        </div>
        {/* Stage pills */}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {PROGRESS_STAGES.map((s, i) => (
            <div key={s} style={{
              width: 6, height: 6, borderRadius: '50%',
              background: i < progressIndex ? 'var(--accent)' : i === progressIndex ? 'var(--accent)' : 'var(--surface-3)',
              opacity: i <= progressIndex ? 1 : 0.4,
            }} />
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 20px', display: 'flex', flexDirection: 'column', gap: 20 }}>

        {skipStage ? (
          <SkipCard onSkip={handleSkip} sending={sending} />
        ) : config ? (
          <OptionStage config={config} selections={selections} onToggle={toggleOption} />
        ) : freeText ? (
          <TextStage config={freeText} value={textValue} onChange={setTextValue} currentStage={currentStage} draft={draft} />
        ) : (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading next step...</div>
        )}

      </div>

      {/* Footer */}
      {!skipStage && (
        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8 }}>
          {freeText && (
            <button onClick={handleSkip} disabled={sending}
              style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12 }}>
              Skip
            </button>
          )}
          <button onClick={handleContinue} disabled={!canContinue || sending}
            style={{ flex: 1, padding: '10px', borderRadius: 6, border: 'none', background: canContinue && !sending ? 'var(--accent)' : 'var(--surface-3)', color: canContinue && !sending ? '#fff' : 'var(--text-muted)', cursor: canContinue && !sending ? 'pointer' : 'default', fontWeight: 600, fontSize: 13, transition: 'background 0.2s' }}>
            {sending ? 'Saving...' : 'Continue →'}
          </button>
        </div>
      )}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function OptionStage({ config, selections, onToggle }) {
  return (
    <>
      <div>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', marginBottom: 6 }}>{config.question}</div>
        {config.type === 'multi' && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Choose up to {config.max}</div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {config.options.map(opt => {
          const selected = selections.includes(opt.value)
          return (
            <div key={opt.value} onClick={() => onToggle(opt.value)}
              style={{
                padding: '12px 16px', borderRadius: 10, cursor: 'pointer',
                border: `2px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
                background: selected ? 'var(--accent-dim)' : 'var(--surface)',
                display: 'flex', alignItems: 'center', gap: 12,
                transition: 'all 0.15s',
              }}>
              <span style={{ fontSize: 22 }}>{opt.icon}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: selected ? 'var(--accent)' : 'var(--text)' }}>{opt.label}</div>
                {opt.desc && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{opt.desc}</div>}
              </div>
              {selected && <span style={{ color: 'var(--accent)', fontSize: 16 }}>✓</span>}
            </div>
          )
        })}
      </div>
    </>
  )
}

function TextStage({ config, value, onChange, currentStage, draft }) {
  const branch = draft?.archetype ?? 'service'

  // Dynamic question labels for branch stages
  const branchQuestions = {
    service: ['What main services do you provide?', 'What info do you need before moving forward with a lead?', 'What\'s the first question you usually ask?'],
    product: ['What\'s on your menu or catalog? What do people ask about most?', 'How do you understand which product fits the customer?', 'What do customers usually ask before buying?'],
    booking: ['What types of appointments or sessions can be booked?', 'What do you need to know before confirming a booking?', 'Are there cases where you shouldn\'t book immediately?'],
  }

  let question = config.question
  let placeholder = config.placeholder

  if (currentStage === 'branch_type_1') question = branchQuestions[branch]?.[0] ?? question
  if (currentStage === 'branch_type_2') question = branchQuestions[branch]?.[1] ?? question
  if (currentStage === 'branch_type_3') question = branchQuestions[branch]?.[2] ?? question

  return (
    <>
      {question && (
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>{question}</div>
      )}
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        rows={6}
        style={{
          width: '100%', padding: 12, borderRadius: 8,
          border: '1px solid var(--border)', background: 'var(--surface)',
          color: 'var(--text)', fontSize: 13, resize: 'vertical',
          fontFamily: 'var(--font-sans)', lineHeight: 1.6,
        }}
      />
    </>
  )
}

function SkipCard({ onSkip, sending }) {
  return (
    <div style={{ textAlign: 'center', paddingTop: 40 }}>
      <div style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 16 }}>
        This step is not required for Support mode.
      </div>
      <button onClick={onSkip} disabled={sending}
        style={{ padding: '10px 24px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontWeight: 600 }}>
        Continue →
      </button>
    </div>
  )
}
