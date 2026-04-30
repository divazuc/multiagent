export const PRESETS = [
  {
    id: 'it-services-il',
    label: 'IT Services (Hebrew)',
    profile: {
      business_name: 'TechPro Solutions',
      business_model: 'service',
      sales_goal: 'call_booking',
      conversation_strategy: 'Filter',
      services: [
        { name: 'IT Support Monthly', price: '299/month', description: 'Full managed IT for SMBs' },
        { name: 'Cybersecurity Audit', price: '1500 one-time', description: 'Full security assessment' },
        { name: 'Cloud Migration', price: 'from 3000', description: 'AWS/Azure migration project' }
      ],
      decision_logic: 'Qualify by company size (5+ employees), then budget, then urgency',
      key_questions: ['How many employees?', 'Do you have existing IT support?', 'What is your biggest pain point?'],
      objection_handling: {
        'too expensive': 'Compare cost of downtime vs monthly fee',
        'already have IT': 'Ask about response time and proactive monitoring',
        'not now': 'Offer a free 30-min audit call to find quick wins'
      },
      persona: {
        tone: 'professional',
        response_length: 'short',
        emoji_usage: 'none',
        behavior_style: 'direct',
        wording_style: 'formal'
      },
      hebrew_patterns: {
        typical_phrases: ['אשמח לקבוע שיחה קצרה', 'בוא נדבר על הצרכים שלך', 'תן לי להבין את המצב'],
        sentence_openings: ['אגב,', 'שאלה קטנה -', 'רק להבין -'],
        common_closings: ['מה אתה אומר?', 'מתי נוח לך לדבר?']
      },
      guardrails: {
        forbidden_claims: ['We are the cheapest', '100% uptime guaranteed'],
        escalate_on: ['legal disputes', 'contracts over 10k', 'angry customer'],
        off_limits: ['competitor pricing', 'personal data of clients']
      }
    }
  },
  {
    id: 'coaching-en',
    label: 'Coaching Business (English)',
    profile: {
      business_name: 'Growth Mindset Coaching',
      business_model: 'booking',
      sales_goal: 'call_booking',
      conversation_strategy: 'Understand',
      services: [
        { name: '1:1 Coaching Session', price: '$150/session', description: '60-min deep-dive coaching call' },
        { name: '3-Month Program', price: '$1200', description: 'Weekly sessions + async support' },
        { name: 'Group Workshop', price: '$49/person', description: 'Monthly group session (max 10)' }
      ],
      decision_logic: 'Understand their goal first, then match to the right program by timeline and budget',
      key_questions: ['What is your main goal right now?', 'Have you worked with a coach before?', 'What is your timeline?'],
      objection_handling: {
        'too expensive': 'What would it be worth to achieve this goal in 3 months?',
        'not sure': 'Let\'s do a free 20-min discovery call — no commitment',
        'need to think': 'What specific question can I answer to help you decide?'
      },
      persona: {
        tone: 'warm',
        response_length: 'medium',
        emoji_usage: 'occasional',
        behavior_style: 'consultative',
        wording_style: 'conversational'
      },
      hebrew_patterns: {},
      guardrails: {
        forbidden_claims: ['I guarantee results', 'This will change your life'],
        escalate_on: ['mental health crisis', 'medical advice requests'],
        off_limits: ['therapy', 'medical diagnosis', 'legal advice']
      }
    }
  }
]

// Shared stage sequence for all archetypes
export const SETUP_STAGES = [
  { key: 'collect_business_model', label: 'Business' },
  { key: 'collect_agent_mode',     label: 'Purpose' },
  { key: 'collect_cta_goal',       label: 'CTA Goal' },
  { key: 'primary_goal',           label: 'Goal' },
  { key: 'conversation_priority',  label: 'Priority' },
  { key: 'branch_type_1',          label: 'Details 1' },
  { key: 'branch_type_2',          label: 'Details 2' },
  { key: 'branch_type_3',          label: 'Details 3' },
  { key: 'persona_tone',           label: 'Tone' },
  { key: 'answer_length',          label: 'Length' },
  { key: 'emoji_style',            label: 'Emoji' },
  { key: 'faq',                    label: 'FAQ' },
  { key: 'objections',             label: 'Objections' },
  { key: 'forbidden_claims',       label: 'Guardrails' },
  { key: 'escalation_rules',       label: 'Escalation' },
  { key: 'final_note',             label: 'Final Note' },
  { key: 'confirm_and_commit',     label: 'Confirm' },
]

export const ARCHETYPE_STAGE_PATHS = {
  service: ['collect_business_model', 'collect_agent_mode', 'collect_cta_goal', 'primary_goal', 'conversation_priority', 'branch_type_1', 'branch_type_2', 'branch_type_3', 'persona_tone', 'answer_length', 'emoji_style', 'faq', 'objections', 'forbidden_claims', 'escalation_rules', 'final_note', 'confirm_and_commit'],
  product: ['collect_business_model', 'collect_agent_mode', 'collect_cta_goal', 'primary_goal', 'conversation_priority', 'branch_type_1', 'branch_type_2', 'branch_type_3', 'persona_tone', 'answer_length', 'emoji_style', 'faq', 'objections', 'forbidden_claims', 'escalation_rules', 'final_note', 'confirm_and_commit'],
  booking: ['collect_business_model', 'collect_agent_mode', 'collect_cta_goal', 'primary_goal', 'conversation_priority', 'branch_type_1', 'branch_type_2', 'branch_type_3', 'persona_tone', 'answer_length', 'emoji_style', 'faq', 'objections', 'forbidden_claims', 'escalation_rules', 'final_note', 'confirm_and_commit'],
}
