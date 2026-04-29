// WA_04 replacement — multi-stage business setup wizard

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';

// Stage → next stage routing
const STAGE_FLOW = {
  collect_business_model:   null,          // determined dynamically by archetype
  // service archetype
  service_collect_offerings: 'service_collect_target',
  service_collect_target:    'service_collect_urgency',
  service_collect_urgency:   'collect_sales_goal',
  // studio archetype
  studio_collect_classes:   'studio_collect_pricing',
  studio_collect_pricing:   'studio_collect_booking',
  studio_collect_booking:   'collect_sales_goal',
  // generic archetype
  generic_collect_services: 'collect_sales_goal',
  // shared tail
  collect_sales_goal:       'collect_persona',
  collect_persona:          'collect_guardrails',
  collect_guardrails:       'confirm_and_commit',
  confirm_and_commit:       'complete',
};

const ARCHETYPE_SECOND_STAGE = {
  service:        'service_collect_offerings',
  professional:   'service_collect_offerings',
  studio:         'studio_collect_classes',
  physical_store: 'generic_collect_services',
  ecommerce:      'generic_collect_services',
  custom_quote:   'generic_collect_services',
};

export async function runSetup({ message, session_id, context }) {
  const stage   = context.current_stage ?? 'collect_business_model';
  const draft   = context.draft_setup_data ?? {};
  const business_id = context.business_id;

  try {
    const { setup_response, extracted_value, next_setup_stage, action } =
      await runStage(stage, message, draft);

    // Merge extracted value into draft
    const updated_draft = { ...draft };
    if (extracted_value && Object.keys(extracted_value).length) {
      updated_draft[stage] = extracted_value;
      // Promote archetype to top-level for routing
      if (stage === 'collect_business_model' && extracted_value.archetype) {
        updated_draft.archetype = extracted_value.archetype;
      }
    }

    const setup_completed = action === 'commit';

    return {
      status: 'success',
      result: {
        setup_response,
        next_setup_stage,
        action: action ?? 'save_draft',
        draft_setup_data: updated_draft,
        setup_completed,
      },
      error: null,
    };
  } catch (e) {
    return { status: 'error', result: null, error: e.message };
  }
}

// ── Stage dispatcher ──────────────────────────────────────────────────────────

async function runStage(stage, message, draft) {
  switch (stage) {
    case 'collect_business_model':   return collectBusinessModel(message, draft);
    case 'service_collect_offerings': return collectServiceOfferings(message, draft);
    case 'service_collect_target':   return collectServiceTarget(message, draft);
    case 'service_collect_urgency':  return collectServiceUrgency(message, draft);
    case 'studio_collect_classes':   return collectStudioClasses(message, draft);
    case 'studio_collect_pricing':   return collectStudioPricing(message, draft);
    case 'studio_collect_booking':   return collectStudioBooking(message, draft);
    case 'generic_collect_services': return collectGenericServices(message, draft);
    case 'collect_sales_goal':       return collectSalesGoal(message, draft);
    case 'collect_persona':          return collectPersona(message, draft);
    case 'collect_guardrails':       return collectGuardrails(message, draft);
    case 'confirm_and_commit':       return confirmAndCommit(message, draft);
    default:                         return collectBusinessModel(message, draft);
  }
}

// ── Individual stage handlers ─────────────────────────────────────────────────

async function collectBusinessModel(message, draft) {
  const system = `You are setting up an AI sales agent for a business owner via WhatsApp.
Identify their business archetype from their message. Be aggressive about extraction — if the message gives any clue, classify it.

Archetypes (pick the best fit):
- service: cleaning, repairs, plumbing, electrician, moving, gardening, consulting
- professional: lawyer, accountant, doctor, therapist, architect, financial advisor
- studio: gym, yoga, pilates, dance, martial arts, fitness studio
- physical_store: retail shop, restaurant, café, hair salon, beauty salon
- ecommerce: online store, dropshipping, digital products
- custom_quote: construction, events, bespoke manufacturing

If the archetype is clear from the message, acknowledge it warmly, confirm understanding, and move on.
If truly unclear, ask ONE specific question.
ALWAYS respond in Hebrew (עברית) unless the owner writes in English.

Return ONLY valid JSON:
{
  "setup_response": "warm acknowledgement or single clarifying question in Hebrew",
  "extracted_value": { "archetype": "<archetype or null only if truly impossible to determine>", "business_model": "<brief description of their business>" },
  "next_setup_stage": "<second stage for their archetype, or collect_business_model if archetype is null>",
  "action": "save_draft"
}`;

  const result = await callClaude(system, `Owner message: "${message}"\nDraft so far: ${JSON.stringify(draft)}`);

  // Fix next stage based on detected archetype
  if (result.extracted_value?.archetype) {
    result.next_setup_stage = ARCHETYPE_SECOND_STAGE[result.extracted_value.archetype] ?? 'generic_collect_services';
  } else {
    result.next_setup_stage = 'collect_business_model';
  }
  return result;
}

async function collectServiceOfferings(message, draft) {
  return callClaude(
    stageSystem('services and pricing', 'Capture their service offerings and pricing model.',
      '{ "services": ["service1","service2"], "pricing_model": "fixed|hourly|custom_quote" }'),
    stageUser(message, draft, 'service_collect_offerings', 'service_collect_target')
  );
}

async function collectServiceTarget(message, draft) {
  return callClaude(
    stageSystem('target audience', 'Who do they serve? Geographic area, demographics, type of client.',
      '{ "target_audience": "...", "area": "..." }'),
    stageUser(message, draft, 'service_collect_target', 'service_collect_urgency')
  );
}

async function collectServiceUrgency(message, draft) {
  return callClaude(
    stageSystem('urgency and lead handling', 'How urgently do leads typically need the service? How do they prefer to handle new leads?',
      '{ "urgency_profile": "immediate|scheduled|flexible", "lead_handling": "..." }'),
    stageUser(message, draft, 'service_collect_urgency', 'collect_sales_goal')
  );
}

async function collectStudioClasses(message, draft) {
  return callClaude(
    stageSystem('classes and schedule', 'What classes or sessions do they offer and when?',
      '{ "classes": ["..."], "schedule_description": "..." }'),
    stageUser(message, draft, 'studio_collect_classes', 'studio_collect_pricing')
  );
}

async function collectStudioPricing(message, draft) {
  return callClaude(
    stageSystem('pricing and membership', 'Single sessions, monthly membership, packages?',
      '{ "pricing_structure": "...", "price_range": "..." }'),
    stageUser(message, draft, 'studio_collect_pricing', 'studio_collect_booking')
  );
}

async function collectStudioBooking(message, draft) {
  return callClaude(
    stageSystem('booking method', 'How do clients book — phone, app, WhatsApp, walk-in?',
      '{ "booking_method": "phone|app|whatsapp|walkin|none", "booking_notes": "..." }'),
    stageUser(message, draft, 'studio_collect_booking', 'collect_sales_goal')
  );
}

async function collectGenericServices(message, draft) {
  return callClaude(
    stageSystem('services and offerings', 'What do they sell or offer? Products, services, or both?',
      '{ "services": ["..."], "pricing_notes": "..." }'),
    stageUser(message, draft, 'generic_collect_services', 'collect_sales_goal')
  );
}

async function collectSalesGoal(message, draft) {
  return callClaude(
    stageSystem('sales goal', 'What should the AI agent focus on — booking calls, collecting leads, answering FAQs, closing sales?',
      '{ "sales_goal": "...", "conversation_strategy": "book_call|collect_lead|answer_faq|close_sale" }'),
    stageUser(message, draft, 'collect_sales_goal', 'collect_persona')
  );
}

async function collectPersona(message, draft) {
  return callClaude(
    stageSystem('agent persona', 'How should the agent sound? Formal or casual? Emoji use? Agent name? Give examples of how they naturally write.',
      '{ "agent_name": "...", "tone": "formal|casual|warm", "emoji_usage": "none|light|heavy", "answer_length": "short|medium|long", "opening_examples": ["..."], "hebrew_patterns": { "greetings": [], "closings": [], "objection_phrases": [], "cta_phrases": [] } }'),
    stageUser(message, draft, 'collect_persona', 'collect_guardrails')
  );
}

async function collectGuardrails(message, draft) {
  return callClaude(
    stageSystem('guardrails', 'What should the agent NEVER say or do? Any topics to avoid? When should it escalate to a human?',
      '{ "forbidden_phrases": ["..."], "escalation_triggers": ["..."], "compliance_notes": "..." }'),
    stageUser(message, draft, 'collect_guardrails', 'confirm_and_commit')
  );
}

async function confirmAndCommit(message, draft) {
  const confirmed = /^(yes|כן|אישור|confirm|ok|sure|good|great|נהדר|בסדר)$/i.test(message.trim());

  const system = `You are finalizing the AI agent setup for a business owner.
${confirmed
  ? 'The owner has confirmed. Present a brief completion message.'
  : 'Present a summary of what was collected and ask for confirmation (yes/כן).'}
Return ONLY valid JSON:
{
  "setup_response": "your message",
  "extracted_value": {},
  "next_setup_stage": "${confirmed ? 'complete' : 'confirm_and_commit'}",
  "action": "${confirmed ? 'commit' : 'save_draft'}"
}`;

  return callClaude(system, `Owner message: "${message}"\nFull setup data: ${JSON.stringify(draft)}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function stageSystem(topic, instruction, jsonShape) {
  return `You are collecting ${topic} for a business owner setting up their WhatsApp AI agent.
${instruction}
Be conversational and warm. ALWAYS respond in Hebrew (עברית) unless the owner writes in English.
Return ONLY valid JSON:
{
  "setup_response": "your question/acknowledgement to the owner",
  "extracted_value": ${jsonShape},
  "next_setup_stage": "<as specified>",
  "action": "save_draft"
}`;
}

function stageUser(message, draft, currentStage, nextStage) {
  return `Owner message: "${message}"
Current stage: ${currentStage}
Next stage: ${nextStage}
Draft so far: ${JSON.stringify(draft)}`;
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
    // Fallback if Claude wraps the JSON unexpectedly
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Failed to parse Claude response: ${text.slice(0, 200)}`);
  }
}
