// WA_04 replacement — multi-stage business setup wizard
// Questions sourced from BIZ_WA_BUSINESS_SETUP_CHAT n8n workflow (Stage Engine)

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL  = 'claude-sonnet-4-6';

// ── Archetype → question branch mapping ───────────────────────────────────────
//
//  service       → service_type  (cleaning, repairs, plumbing, gardening, moving)
//  professional  → ask first     (lawyer, doctor, accountant — could be service OR booking)
//  studio        → booking_type  (gym, yoga, pilates, dance — classes booked by time)
//  physical_store → product_type (restaurant, café, spa, salon — fixed menu/price list)
//  ecommerce     → product_type  (online store — fixed-price catalog)
//  custom_quote  → service_type  (construction, events — discovery + custom quote)

const ARCHETYPE_BRANCH = {
  service:        'service',
  custom_quote:   'service',
  studio:         'booking',
  physical_store: 'product',
  ecommerce:      'product',
  professional:   null,   // determined by sub-question during setup
};

// After archetype identified, go to primary_goal first (shared), then branch
const ARCHETYPE_SECOND_STAGE = {
  service:        'primary_goal',
  custom_quote:   'primary_goal',
  studio:         'primary_goal',
  physical_store: 'primary_goal',
  ecommerce:      'primary_goal',
  professional:   'professional_mode',  // sub-question: appointment vs. consult
};

// After professional_mode is answered, which branch?
// Stored in draft.routing.professional_mode = 'booking' | 'service'
const PROFESSIONAL_BRANCH_STAGE = 'primary_goal';

// Stage flow — branch_type_1/2/3 are resolved dynamically from draft.routing.branch
const STAGE_FLOW = {
  collect_business_model: null,           // archetype detection
  professional_mode:      PROFESSIONAL_BRANCH_STAGE,
  primary_goal:           'conversation_priority',
  conversation_priority:  null,           // → branch_type_1 (resolved dynamically)
  branch_type_1:          'branch_type_2',
  branch_type_2:          'branch_type_3',
  branch_type_3:          'persona_tone',
  persona_tone:           'answer_length',
  answer_length:          'emoji_style',
  emoji_style:            'faq',
  faq:                    'objections',
  objections:             'forbidden_claims',
  forbidden_claims:       'escalation_rules',
  escalation_rules:       'final_note',
  final_note:             'confirm_and_commit',
  confirm_and_commit:     'complete',
};

// ── Keyword fallback for archetype detection ───────────────────────────────────
const ARCHETYPE_KEYWORDS = {
  studio:         ['חדר כושר', 'כושר', 'יוגה', 'פילאטיס', 'ריקוד', 'מחול', 'trx', 'gym', 'yoga', 'pilates', 'dance', 'סטודיו', 'studio', 'spinning', 'crossfit'],
  professional:   ['עורך דין', 'רופא', 'רואה חשבון', 'פסיכולוג', 'אדריכל', 'יועץ', 'מאמן', 'lawyer', 'doctor', 'accountant', 'therapist', 'architect', 'coach', 'consultant'],
  physical_store: ['מסעדה', 'קפה', 'ספא', 'סלון', 'מספרה', 'בית קפה', 'restaurant', 'cafe', 'spa', 'salon', 'barbershop', 'pharmacy', 'בית מרקחת'],
  ecommerce:      ['חנות אינטרנטית', 'אונליין', 'דרופשיפינג', 'online store', 'ecommerce', 'dropship', 'shopify'],
  service:        ['ניקיון', 'אינסטלציה', 'חשמל', 'גינון', 'הובלה', 'תיקון', 'שיפוץ', 'מיזוג', 'cleaning', 'plumb', 'electric', 'garden', 'moving', 'repair', 'renovation', 'pest'],
  custom_quote:   ['בנייה', 'אירועים', 'ייצור', 'construction', 'events', 'manufacturing', 'bespoke'],
};

function detectArchetypeFromKeywords(text) {
  const lower = text.toLowerCase();
  for (const [archetype, keywords] of Object.entries(ARCHETYPE_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) return archetype;
  }
  return null;
}

// ── Questions (from n8n Stage Engine, verbatim) ───────────────────────────────
const QUESTIONS = {
  // Shared
  primary_goal:          'What is the main action you want a new lead to take?\n1. Book a call\n2. Leave details\n3. Make a purchase\n4. Continue chatting to clarify needs',
  conversation_priority: 'What matters most to you in the first conversation?\n1. Understand the need\n2. Filter irrelevant leads\n3. Close quickly\n4. Give information only',
  // Service branch (service, custom_quote, professional→consult)
  service_type_1:        'What main services do you provide?',
  service_type_2:        'What information is important for you to understand before moving forward with a lead?',
  service_type_3:        'What is usually the first question you ask to understand the lead?',
  // Product branch (physical_store, ecommerce)
  product_type_1_ecommerce:      'What main products or categories do you sell?',
  product_type_1_physical_store: 'What is on your menu or service list? What do people usually ask about?',
  product_type_2:        'How do you usually understand which product or service fits the customer?',
  product_type_3:        'What questions do customers usually ask before buying or booking?',
  // Booking branch (studio, professional→appointment)
  booking_type_1:        'What types of appointments, treatments, or sessions can be booked?',
  booking_type_2:        'What is important for you to understand before confirming a booking?',
  booking_type_3:        'Are there cases where it is not right to book immediately?',
  // Persona
  persona_tone:          'How do you want to sound with customers? Casual / professional / direct / friendly / other',
  answer_length:         'Do you prefer very short, medium, or slightly more detailed replies?',
  emoji_style:           'Do you want emojis? none / light / natural / free',
  // Knowledge
  faq:                   'Give 2–3 questions customers ask often, and how you usually answer them.',
  objections:            'What are 2–3 common objections you hear, and how do you usually respond?',
  // Guardrails
  forbidden_claims:      'Are there things you do not want to say or promise in an initial conversation?',
  escalation_rules:      'In which cases should the conversation be handed off to a real person?',
  final_note:            'If there is one thing the assistant must not miss in the way you talk to customers, what is it?',
};

// Resolve branch_type question key from draft
function getBranchQuestion(draft, position) {
  const branch   = draft.routing?.branch ?? 'service';
  const archetype = draft.archetype;
  if (branch === 'product' && position === 1) {
    return archetype === 'ecommerce' ? 'product_type_1_ecommerce' : 'product_type_1_physical_store';
  }
  return `${branch}_type_${position}`;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runSetup({ message, session_id, context }) {
  const stage        = context.current_stage ?? 'collect_business_model';
  const draft        = context.draft_setup_data ?? {};

  try {
    const { setup_response, extracted_value, next_setup_stage, action } =
      await runStage(stage, message, draft);

    const updated_draft = mergeDraft(draft, stage, extracted_value);
    const setup_completed = action === 'commit';

    return {
      status:  'success',
      result: { setup_response, next_setup_stage, action: action ?? 'save_draft', draft_setup_data: updated_draft, setup_completed },
      error:   null,
    };
  } catch (e) {
    return { status: 'error', result: null, error: e.message };
  }
}

// ── Stage dispatcher ──────────────────────────────────────────────────────────

async function runStage(stage, message, draft) {
  switch (stage) {
    case 'collect_business_model': return stageCollectBusinessModel(message, draft);
    case 'professional_mode':      return stageProfessionalMode(message, draft);
    case 'primary_goal':           return stageAsk('primary_goal', 'primary_goal', 'routing.primary_goal', 'conversation_priority', message, draft);
    case 'conversation_priority':  return stageConversationPriority(message, draft);
    case 'branch_type_1':          return stageBranchType(1, message, draft);
    case 'branch_type_2':          return stageBranchType(2, message, draft);
    case 'branch_type_3':          return stageBranchType(3, message, draft);
    case 'persona_tone':           return stageAsk('persona_tone', 'persona tone', 'persona.tone', 'answer_length', message, draft);
    case 'answer_length':          return stageAsk('answer_length', 'reply length', 'persona.answer_length', 'emoji_style', message, draft);
    case 'emoji_style':            return stageAsk('emoji_style', 'emoji usage', 'persona.emoji_style', 'faq', message, draft);
    case 'faq':                    return stageAsk('faq', 'FAQ', 'knowledge.faq', 'objections', message, draft);
    case 'objections':             return stageAsk('objections', 'objection handling', 'knowledge.objection_handling', 'forbidden_claims', message, draft);
    case 'forbidden_claims':       return stageAsk('forbidden_claims', 'forbidden claims', 'guardrails.forbidden_claims', 'escalation_rules', message, draft);
    case 'escalation_rules':       return stageAsk('escalation_rules', 'escalation rules', 'guardrails.escalation_rules', 'final_note', message, draft);
    case 'final_note':             return stageAsk('final_note', 'final note', 'persona.must_not_miss', 'confirm_and_commit', message, draft);
    case 'confirm_and_commit':     return stageConfirmAndCommit(message, draft);
    default:                       return stageCollectBusinessModel(message, draft);
  }
}

// ── Stage handlers ────────────────────────────────────────────────────────────

async function stageCollectBusinessModel(message, draft) {
  const keywordArchetype = detectArchetypeFromKeywords(message);

  const system = `You are setting up a WhatsApp AI sales agent for a business owner.
Identify their business archetype from their message. Be decisive — classify if there is any clue.

Archetypes:
- service: cleaning, repairs, plumbing, electrician, pest control, moving, gardening, home services
- professional: lawyer, accountant, doctor, therapist, architect, financial advisor, coach, consultant
- studio: gym, fitness, yoga, pilates, dance, martial arts, CrossFit, spinning
- physical_store: restaurant, café, spa, hair salon, beauty salon, pharmacy
- ecommerce: online store, dropshipping, digital products, marketplace
- custom_quote: construction, events, manufacturing, bespoke projects

If the archetype is clear → acknowledge warmly and confirm.
If truly unclear → ask ONE specific question.
ALWAYS respond in Hebrew unless the owner writes in English.
Return ONLY valid JSON:
{"setup_response":"...","extracted_value":{"archetype":"<archetype or null>","business_model":"..."},"next_setup_stage":"...","action":"save_draft"}`;

  const result = await callClaude(system,
    `Owner message: "${message}"\n${keywordArchetype ? `Keyword hint: "${keywordArchetype}"` : ''}\nDraft: ${JSON.stringify(draft)}`
  );

  let archetype = result.extracted_value?.archetype;
  if (!ARCHETYPE_SECOND_STAGE[archetype]) archetype = null;
  if (!archetype) archetype = keywordArchetype;

  if (archetype) {
    result.extracted_value = { ...result.extracted_value, archetype };
    result.next_setup_stage = ARCHETYPE_SECOND_STAGE[archetype];
  } else {
    result.next_setup_stage = 'collect_business_model';
  }

  return result;
}

async function stageProfessionalMode(message, draft) {
  // Ask professional whether they book appointments or do consultations/quotes
  const system = `You are setting up a WhatsApp AI sales agent for a professional service business.
Ask the owner ONE question to understand their primary client interaction model:
- Do clients book an appointment with them directly?
- Or do clients first discuss their needs and then receive a proposal/quote?

Based on their answer, classify as "booking" or "service".
ALWAYS respond in Hebrew unless the owner writes in English.
Return ONLY valid JSON:
{"setup_response":"...","extracted_value":{"professional_mode":"booking|service"},"next_setup_stage":"primary_goal","action":"save_draft"}`;

  const result = await callClaude(system,
    `Owner message: "${message}"\nDraft: ${JSON.stringify(draft)}`
  );

  // Persist branch in routing so the rest of the flow knows which questions to ask
  const mode   = result.extracted_value?.professional_mode ?? 'service';
  result.extracted_value = { professional_mode: mode, branch: mode };
  result.next_setup_stage = 'primary_goal';
  return result;
}

async function stageConversationPriority(message, draft) {
  const branch = draft.routing?.branch ?? draft.archetype_branch ?? branchFromArchetype(draft.archetype);
  const result = await stageAsk('conversation_priority', 'conversation priority', 'routing.conversation_priority', 'branch_type_1', message, draft);
  // Ensure branch is stored so dynamic stage resolution works
  if (!draft.routing?.branch) {
    result.extracted_value = { ...result.extracted_value, branch };
  }
  return result;
}

async function stageBranchType(position, message, draft) {
  const branch       = draft.routing?.branch ?? branchFromArchetype(draft.archetype);
  const questionKey  = getBranchQuestion({ ...draft, routing: { ...(draft.routing ?? {}), branch } }, position);
  const question     = QUESTIONS[questionKey] ?? `Tell me more about your ${branch} (question ${position})`;
  const draftPath    = `business_profile.${questionKey}`;
  const next         = position < 3 ? `branch_type_${position + 1}` : 'persona_tone';

  const system = `You are collecting business information for a WhatsApp AI sales agent setup.
Ask or acknowledge the following question naturally and extract the answer:

Question: "${question}"

Be conversational and warm. Extract what you can — even partial info counts.
ALWAYS respond in Hebrew unless the owner writes in English.
Return ONLY valid JSON:
{"setup_response":"...","extracted_value":{"${draftPath.split('.').pop()}":"..."},"next_setup_stage":"${next}","action":"save_draft"}`;

  return callClaude(system, `Owner message: "${message}"\nDraft so far: ${JSON.stringify(draft)}`);
}

async function stageAsk(questionKey, topic, draftPath, nextStage, message, draft) {
  const question = QUESTIONS[questionKey] ?? `Tell me about your ${topic}.`;
  const field    = draftPath.split('.').pop();

  const system = `You are collecting ${topic} information for a WhatsApp AI sales agent setup.
Ask or acknowledge this question naturally and extract the answer:

Question: "${question}"

Be conversational and warm. Extract what you can — even partial info counts.
ALWAYS respond in Hebrew unless the owner writes in English.
Return ONLY valid JSON:
{"setup_response":"...","extracted_value":{"${field}":"..."},"next_setup_stage":"${nextStage}","action":"save_draft"}`;

  return callClaude(system, `Owner message: "${message}"\nDraft so far: ${JSON.stringify(draft)}`);
}

async function stageConfirmAndCommit(message, draft) {
  const confirmed = /^(yes|כן|אישור|confirm|ok|sure|good|great|נהדר|בסדר|approve|אשר)$/i.test(message.trim());

  const system = `You are finalizing the AI agent setup for a business owner.
${confirmed
  ? 'The owner confirmed. Send a short warm completion message in Hebrew.'
  : 'Present a clean summary of everything collected and ask for confirmation (yes/כן) in Hebrew.'}
Return ONLY valid JSON:
{"setup_response":"...","extracted_value":{},"next_setup_stage":"${confirmed ? 'complete' : 'confirm_and_commit'}","action":"${confirmed ? 'commit' : 'save_draft'}"}`;

  return callClaude(system, `Owner message: "${message}"\nFull setup data: ${JSON.stringify(draft)}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function branchFromArchetype(archetype) {
  return ARCHETYPE_BRANCH[archetype] ?? 'service';
}

function mergeDraft(draft, stage, extracted_value) {
  if (!extracted_value || !Object.keys(extracted_value).length) return draft;

  const updated = { ...draft };

  // Top-level promotions
  if (stage === 'collect_business_model' && extracted_value.archetype) {
    updated.archetype       = extracted_value.archetype;
    updated.archetype_branch = branchFromArchetype(extracted_value.archetype);
  }

  // Routing fields
  if (extracted_value.branch || extracted_value.professional_mode || extracted_value.primary_goal || extracted_value.conversation_priority) {
    updated.routing = { ...(updated.routing ?? {}), ...extracted_value };
    // Ensure branch is always set from archetype if not explicitly provided
    if (!updated.routing.branch) {
      updated.routing.branch = branchFromArchetype(updated.archetype);
    }
  }

  // Nested path writes (persona.*, knowledge.*, guardrails.*, business_profile.*)
  for (const [key, value] of Object.entries(extracted_value)) {
    if (['branch', 'professional_mode', 'primary_goal', 'conversation_priority', 'archetype', 'business_model'].includes(key)) continue;
    const prefixMap = {
      tone: 'persona', answer_length: 'persona', emoji_style: 'persona', must_not_miss: 'persona',
      faq: 'knowledge', objection_handling: 'knowledge',
      forbidden_claims: 'guardrails', escalation_rules: 'guardrails',
    };
    const prefix = prefixMap[key];
    if (prefix) {
      updated[prefix] = { ...(updated[prefix] ?? {}), [key]: value };
    } else {
      updated.business_profile = { ...(updated.business_profile ?? {}), [key]: value };
    }
  }

  return updated;
}

async function callClaude(system, userPrompt, maxTokens = 1024) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content[0].text.replace(/```json\n?|\n?```/g, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Failed to parse Claude response: ${text.slice(0, 200)}`);
  }
}
