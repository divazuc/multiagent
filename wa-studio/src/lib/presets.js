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

// All possible stages — bar shows current position regardless of archetype path
export const SETUP_STAGES = [
  { key: 'collect_business_model',   label: 'Business' },
  // service / professional path
  { key: 'service_collect_offerings', label: 'Services' },
  { key: 'service_collect_target',    label: 'Customers' },
  { key: 'service_collect_urgency',   label: 'Availability' },
  // studio path
  { key: 'studio_collect_classes',   label: 'Classes' },
  { key: 'studio_collect_pricing',   label: 'Pricing' },
  { key: 'studio_collect_booking',   label: 'Booking' },
  // generic path
  { key: 'generic_collect_services', label: 'Services' },
  // shared tail
  { key: 'collect_sales_goal',       label: 'Goal' },
  { key: 'collect_persona',          label: 'Persona' },
  { key: 'collect_guardrails',       label: 'Guardrails' },
  { key: 'confirm_and_commit',       label: 'Confirm' },
]

// Stage paths per archetype — used to filter the progress bar to show only relevant stages
export const ARCHETYPE_STAGE_PATHS = {
  service:        ['collect_business_model', 'service_collect_offerings', 'service_collect_target', 'service_collect_urgency', 'collect_sales_goal', 'collect_persona', 'collect_guardrails', 'confirm_and_commit'],
  professional:   ['collect_business_model', 'service_collect_offerings', 'service_collect_target', 'service_collect_urgency', 'collect_sales_goal', 'collect_persona', 'collect_guardrails', 'confirm_and_commit'],
  studio:         ['collect_business_model', 'studio_collect_classes', 'studio_collect_pricing', 'studio_collect_booking', 'collect_sales_goal', 'collect_persona', 'collect_guardrails', 'confirm_and_commit'],
  physical_store: ['collect_business_model', 'generic_collect_services', 'collect_sales_goal', 'collect_persona', 'collect_guardrails', 'confirm_and_commit'],
  ecommerce:      ['collect_business_model', 'generic_collect_services', 'collect_sales_goal', 'collect_persona', 'collect_guardrails', 'confirm_and_commit'],
  custom_quote:   ['collect_business_model', 'generic_collect_services', 'collect_sales_goal', 'collect_persona', 'collect_guardrails', 'confirm_and_commit'],
}
