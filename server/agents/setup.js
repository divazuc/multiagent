// WA_04 replacement — multi-stage business setup wizard
// 3 archetypes: service / product / booking
// Agent modes: sales / support / hybrid

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL  = 'claude-sonnet-4-6';

// ── 3 archetypes ─────────────────────────────────────────────────────────────
//
//  service  → cleaning, repairs, consulting, legal, accounting, construction
//  product  → restaurant, café, spa menu, ecommerce, retail
//  booking  → gym, yoga, nail salon, hair salon, physio, dentist, any appointment-based

const ARCHETYPE_BRANCH = {
  service: 'service',
  product: 'product',
  booking: 'booking',
};

const ARCHETYPE_SECOND_STAGE = {
  service: 'collect_agent_mode',
  product: 'collect_agent_mode',
  booking: 'collect_agent_mode',
};

// ── Keyword detection ─────────────────────────────────────────────────────────
const ARCHETYPE_KEYWORDS = {
  booking: [
    'חדר כושר', 'כושר', 'יוגה', 'פילאטיס', 'ריקוד', 'מחול', 'trx', 'gym', 'yoga', 'pilates',
    'dance', 'סטודיו', 'studio', 'spinning', 'crossfit', 'ציפורניים', 'מניקור', 'פדיקור',
    'מספרה', 'ספא', 'עיסוי', 'פיזיותרפיה', 'אוסטאופת', 'קליניקה', 'רופא שיניים', 'דנטיסט',
    'nail salon', 'barbershop', 'spa', 'massage', 'physio', 'dentist', 'clinic', 'appointment',
    'סלון יופי', 'hair salon', 'beauty salon',
  ],
  product: [
    'מסעדה', 'קפה', 'בית קפה', 'חנות', 'מוצרים', 'אונליין', 'חנות אינטרנטית', 'דרופשיפינג',
    'restaurant', 'cafe', 'store', 'shop', 'ecommerce', 'dropship', 'shopify', 'online store',
    'תפריט', 'מחירון', 'קטלוג', 'menu', 'catalog', 'retail',
  ],
  service: [
    'ניקיון', 'אינסטלציה', 'חשמל', 'גינון', 'הובלה', 'תיקון', 'שיפוץ', 'מיזוג', 'בנייה',
    'עורך דין', 'רואה חשבון', 'פסיכולוג', 'יועץ', 'מאמן', 'אדריכל', 'מהנדס',
    'cleaning', 'plumb', 'electric', 'garden', 'moving', 'repair', 'renovation', 'pest',
    'construction', 'lawyer', 'accountant', 'therapist', 'consultant', 'coach', 'architect',
    'events', 'אירועים', 'ייצור', 'manufacturing',
  ],
};

function detectArchetypeFromKeywords(text) {
  const lower = text.toLowerCase();
  for (const [archetype, keywords] of Object.entries(ARCHETYPE_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) return archetype;
  }
  return null;
}

// ── Questions (from n8n Stage Engine) ────────────────────────────────────────
const QUESTIONS = {
  // Shared
  primary_goal:          'What is the main action you want a new lead to take?\n1. Book a call\n2. Leave details\n3. Make a purchase\n4. Continue chatting to clarify needs',
  conversation_priority: 'What matters most to you in the first conversation?\n1. Understand the need\n2. Filter irrelevant leads\n3. Close quickly\n4. Give information only',
  // Service branch
  service_type_1: 'What main services do you provide?',
  service_type_2: 'What information is important for you to understand before moving forward with a lead?',
  service_type_3: 'What is usually the first question you ask to understand the lead?',
  // Product branch
  product_type_1_product: 'What is on your menu or service list? What do people usually ask about?',
  product_type_2:         'How do you usually understand which product or service fits the customer?',
  product_type_3:         'What questions do customers usually ask before buying or booking?',
  // Booking branch
  booking_type_1: 'What types of appointments, treatments, or sessions can be booked?',
  booking_type_2: 'What is important for you to understand before confirming a booking?',
  booking_type_3: 'Are there cases where it is not right to book immediately?',
  // Persona
  persona_tone:   'How do you want to sound with customers? Casual / professional / direct / friendly / other',
  answer_length:  'Do you prefer very short, medium, or slightly more detailed replies?',
  emoji_style:    'Do you want emojis? none / light / natural / free',
  // Knowledge
  faq:            'Give 2–3 questions customers ask often, and how you usually answer them.',
  objections:     'What are 2–3 common objections you hear, and how do you usually respond?',
  // Guardrails
  forbidden_claims:  'Are there things you do not want to say or promise in an initial conversation?',
  escalation_rules:  'In which cases should the conversation be handed off to a real person?',
  final_note:        'If there is one thing the assistant must not miss in the way you talk to customers, what is it?',
};

function getBranchQuestion(draft, position) {
  const branch = draft.routing?.branch ?? 'service';
  if (branch === 'product' && position === 1) return 'product_type_1_product';
  return `${branch}_type_${position}`;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runSetup({ message, session_id, context }) {
  const stage = context.current_stage ?? 'collect_business_model';
  const draft = context.draft_setup_data ?? {};

  try {
    const { setup_response, extracted_value, next_setup_stage, action } =
      await runStage(stage, message, draft);

    const updated_draft = mergeDraft(draft, stage, extracted_value);
    const setup_completed = action === 'commit';

    return {
      status: 'success',
      result: { setup_response, next_setup_stage, action: action ?? 'save_draft', draft_setup_data: updated_draft, setup_completed },
      error: null,
    };
  } catch (e) {
    return { status: 'error', result: null, error: e.message };
  }
}

// ── Stage dispatcher ──────────────────────────────────────────────────────────

async function runStage(stage, message, draft) {
  switch (stage) {
    case 'collect_business_model': return stageCollectBusinessModel(message, draft);
    case 'collect_agent_mode':     return stageCollectAgentMode(message, draft);
    case 'collect_cta_goal':       return stageCollectCtaGoal(message, draft);
    case 'primary_goal':           return stageAsk('primary_goal', 'primary goal', 'routing.primary_goal', 'conversation_priority', message, draft);
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
Identify their business type from their message. Be decisive — classify if there is any clue.

Business types:
- service: cleaning, repairs, consulting, legal, accounting, construction, any relationship/custom-offer business
- product: restaurant, café, spa menu, ecommerce, retail — anything with a fixed menu or catalog
- booking: gym, yoga, nail salon, hair salon, physio, dentist — any appointment/time-slot based business

If clear → acknowledge warmly and confirm.
If unclear → ask ONE specific question.
ALWAYS respond in Hebrew unless the owner writes in English.
Return ONLY valid JSON:
{"setup_response":"...","extracted_value":{"archetype":"service|product|booking or null","business_model":"..."},"next_setup_stage":"...","action":"save_draft"}`;

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

async function stageCollectAgentMode(message, draft) {
  const system = `You are setting up a WhatsApp AI sales agent.
Ask the business owner what the agent's main purpose is. Present these 3 options clearly:

1. Sales — Push leads toward a conversion (book appointment, get a quote, make a purchase)
2. Support — Answer customer questions, handle complaints, provide information
3. Hybrid — Answer questions first, then gently guide toward a conversion

Extract their choice and return it.
ALWAYS respond in Hebrew unless the owner writes in English.
Return ONLY valid JSON:
{"setup_response":"...","extracted_value":{"agent_mode":"sales|support|hybrid"},"next_setup_stage":"collect_cta_goal","action":"save_draft"}

If they chose "support", set next_setup_stage to "primary_goal" instead (no CTA goal needed).`;

  const result = await callClaude(system,
    `Owner message: "${message}"\nDraft: ${JSON.stringify(draft)}`
  );

  const mode = result.extracted_value?.agent_mode;

  // Support mode skips CTA goal — goes straight to branch questions
  if (mode === 'support') {
    result.next_setup_stage = 'primary_goal';
  } else if (mode) {
    result.next_setup_stage = 'collect_cta_goal';
  } else {
    result.next_setup_stage = 'collect_agent_mode';
  }

  return result;
}

async function stageCollectCtaGoal(message, draft) {
  const archetype = draft.archetype ?? 'service';

  const ctaOptions = {
    service: '1. Book a call\n2. Get a quote\n3. Leave details\n4. Continue chatting',
    product: '1. Make a purchase\n2. Book a table / appointment\n3. Get a price list\n4. Leave details',
    booking: '1. Book an appointment\n2. Book a trial session\n3. Get pricing info\n4. Leave details',
  };

  const system = `You are setting up a WhatsApp AI sales agent.
Ask the business owner what the main conversion goal is for new leads. Present these options:

${ctaOptions[archetype] ?? ctaOptions.service}

Extract their choice.
ALWAYS respond in Hebrew unless the owner writes in English.
Return ONLY valid JSON:
{"setup_response":"...","extracted_value":{"cta_goal":"book_call|get_quote|purchase|book_appointment|get_price_list|leave_details"},"next_setup_stage":"primary_goal","action":"save_draft"}`;

  return callClaude(system,
    `Owner message: "${message}"\nBusiness type: ${archetype}\nDraft: ${JSON.stringify(draft)}`
  );
}

async function stageConversationPriority(message, draft) {
  const branch = draft.routing?.branch ?? draft.archetype ?? 'service';
  const result = await stageAsk('conversation_priority', 'conversation priority', 'routing.conversation_priority', 'branch_type_1', message, draft);
  if (!draft.routing?.branch) {
    result.extracted_value = { ...result.extracted_value, branch };
  }
  return result;
}

async function stageBranchType(position, message, draft) {
  const branch      = draft.routing?.branch ?? draft.archetype ?? 'service';
  const questionKey = getBranchQuestion({ ...draft, routing: { ...(draft.routing ?? {}), branch } }, position);
  const question    = QUESTIONS[questionKey] ?? `Tell me more about your ${branch} (question ${position})`;
  const next        = position < 3 ? `branch_type_${position + 1}` : 'persona_tone';

  const system = `You are collecting business information for a WhatsApp AI agent setup.
Ask or acknowledge this question naturally and extract the answer:

"${question}"

Be conversational and warm. Extract what you can — partial info counts.
ALWAYS respond in Hebrew unless the owner writes in English.
Return ONLY valid JSON:
{"setup_response":"...","extracted_value":{"${questionKey}":"..."},"next_setup_stage":"${next}","action":"save_draft"}`;

  return callClaude(system, `Owner message: "${message}"\nDraft: ${JSON.stringify(draft)}`);
}

async function stageAsk(questionKey, topic, draftPath, nextStage, message, draft) {
  const question = QUESTIONS[questionKey] ?? `Tell me about your ${topic}.`;
  const field    = draftPath.split('.').pop();

  const system = `You are collecting ${topic} information for a WhatsApp AI agent setup.
Ask or acknowledge this question naturally and extract the answer:

"${question}"

Be conversational and warm. Extract what you can — partial info counts.
ALWAYS respond in Hebrew unless the owner writes in English.
Return ONLY valid JSON:
{"setup_response":"...","extracted_value":{"${field}":"..."},"next_setup_stage":"${nextStage}","action":"save_draft"}`;

  return callClaude(system, `Owner message: "${message}"\nDraft: ${JSON.stringify(draft)}`);
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

function mergeDraft(draft, stage, extracted_value) {
  if (!extracted_value || !Object.keys(extracted_value).length) return draft;

  const updated = { ...draft };

  if (stage === 'collect_business_model' && extracted_value.archetype) {
    updated.archetype        = extracted_value.archetype;
    updated.archetype_branch = extracted_value.archetype;
  }

  if (extracted_value.agent_mode) updated.agent_mode = extracted_value.agent_mode;
  if (extracted_value.cta_goal)   updated.cta_goal   = extracted_value.cta_goal;

  if (extracted_value.branch || extracted_value.primary_goal || extracted_value.conversation_priority) {
    updated.routing = { ...(updated.routing ?? {}), ...extracted_value };
    if (!updated.routing.branch) updated.routing.branch = updated.archetype ?? 'service';
  }

  const prefixMap = {
    tone: 'persona', answer_length: 'persona', emoji_style: 'persona', must_not_miss: 'persona',
    faq: 'knowledge', objection_handling: 'knowledge',
    forbidden_claims: 'guardrails', escalation_rules: 'guardrails',
  };

  for (const [key, value] of Object.entries(extracted_value)) {
    if (['branch', 'agent_mode', 'cta_goal', 'primary_goal', 'conversation_priority', 'archetype', 'business_model'].includes(key)) continue;
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
