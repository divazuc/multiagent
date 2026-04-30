import express from 'express';
import { normalizeMessage } from './lib/normalize.js';
import { loadContext } from './lib/context.js';
import { saveConversation, saveSetupState } from './lib/db.js';
import { startRun, stepStart, stepDone, completeRun } from './lib/logger.js';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'https://multiagent.pages.dev')
  .split(',').map(s => s.trim());

// Agents — imported lazily so missing files don't crash startup
let runConversation = null, runSetup = null, runLearning = null;
async function loadAgents() {
  const [conv, setup, learning] = await Promise.all([
    import('./agents/conversation.js').catch(e => { console.error('[loadAgents] conversation:', e.message); return {}; }),
    import('./agents/setup.js').catch(e => { console.error('[loadAgents] setup:', e.message); return {}; }),
    import('./agents/learning.js').catch(() => ({})),
  ]);
  runConversation = conv.runConversation ?? null;
  runSetup        = setup.runSetup ?? null;
  runLearning     = learning.runLearning ?? null;
  console.log('[loadAgents] runConversation:', typeof runConversation, '| runSetup:', typeof runSetup, '| runLearning:', typeof runLearning);
}

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || ALLOWED_ORIGINS.includes(origin)) {
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Inbound WhatsApp webhook ──────────────────────────────────────────────────
app.post('/wa-inbound', async (req, res) => {
  const run = await startRun({ session_id: 'unknown', inbound_message: '[pending]' });

  try {
    // Step 1 — Normalize
    let h = stepStart(run, 'normalize', { body: req.body });
    const normalized = normalizeMessage(req.body);
    await stepDone(h, normalized);

    if (normalized.status !== 'success') {
      await completeRun(run, { error: normalized.error });
      return res.status(400).json({ status: 'error', message: normalized.error });
    }

    const { message, session_id } = normalized.result;
    run.session_id = session_id;

    // Step 2 — Load context
    h = stepStart(run, 'load_context', { session_id });
    const ctx = await loadContext({ message, session_id });
    await stepDone(h, ctx);

    if (ctx.status !== 'success') {
      await completeRun(run, { error: ctx.error });
      return res.status(500).json({ status: 'error', message: ctx.error });
    }

    const context = ctx.result;
    const { session_mode, business_id } = context;
    run.business_id = business_id;

    // Step 3 — Route by session mode
    let agentResult;

    if (session_mode === 'setup') {
      h = stepStart(run, 'setup_agent', { session_id, session_mode });
      agentResult = runSetup
        ? await runSetup({ message, session_id, context })
        : stub('setup');
      await stepDone(h, agentResult);

    } else if (session_mode === 'learning') {
      h = stepStart(run, 'learning_agent', { session_id, session_mode });
      agentResult = runLearning
        ? await runLearning({ message, session_id, context })
        : stub('learning');
      await stepDone(h, agentResult);

    } else {
      // live
      h = stepStart(run, 'conversation_agent', { session_id, session_mode });
      agentResult = runConversation
        ? await runConversation({ message, session_id, context })
        : stub('conversation');
      await stepDone(h, agentResult);
    }

    if (agentResult.status !== 'success') {
      await completeRun(run, { session_mode, error: agentResult.error });
      return res.status(500).json({ status: 'error', message: agentResult.error });
    }

    const r = agentResult.result;
    const final_response = r?.response ?? r?.setup_response ?? '';

    // Step 4 — Persist state
    if (session_mode === 'live') {
      h = stepStart(run, 'save_conversation', {});
      const saved = await saveConversation({
        session_id, business_id,
        user_message: message, agent_response: final_response,
        stage: r.next_stage, action: r.action,
        qualification_progress: r.qualification_progress,
        cta_triggered: r.cta_triggered, escalate: r.escalate,
        escalation_reason: r.escalation_reason, language: r.language,
      });
      await stepDone(h, saved);

    } else if (session_mode === 'setup' && r.action && r.action !== 'none') {
      h = stepStart(run, 'save_setup_state', {});
      const saved = await saveSetupState({
        session_id, business_id,
        action: r.action,
        current_setup_stage: context.current_stage,
        next_setup_stage: r.next_setup_stage,
        draft_setup_data: r.draft_setup_data,
        setup_completed: r.setup_completed ?? false,
      });
      await stepDone(h, saved);
    }

    await completeRun(run, { final_response, session_mode });

    return res.json({
      status: 'success',
      message: final_response,
      state: {
        session_id,
        stage: r?.next_setup_stage ?? r?.next_stage ?? context.current_stage,
      },
    });

  } catch (e) {
    console.error('[orchestrator] unhandled error:', e);
    await completeRun(run, { error: e.message });
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

// ── Setup: direct structured save (no LLM) ───────────────────────────────────
// Used by the wizard for clickable stages — fast, no Claude call needed

const SETUP_STAGE_FLOW = {
  business_type:    'faq_topics',
  faq_topics:       'cta_goal',
  cta_goal:         null,           // resolved dynamically (support→tone, else→push_speed)
  push_speed:       'tone',
  tone:             'response_length',
  response_length:  'emoji_usage',
  emoji_usage:      'escalation',
  escalation:       'faq_examples',
  faq_examples:     'objections',
  objections:       'forbidden_claims',
  forbidden_claims: 'final_note',
  final_note:       'confirm_and_commit',
};

app.post('/setup/save', async (req, res) => {
  const { session_id, stage, value } = req.body;
  if (!session_id || !stage || value === undefined) {
    return res.status(400).json({ status: 'error', message: 'session_id, stage, value required' });
  }

  try {
    const { supabase } = await import('./lib/supabase.js');

    // Load current draft
    const { data: draftRow } = await supabase
      .from('setup_drafts')
      .select('draft_setup_data, current_setup_stage')
      .eq('session_id', session_id)
      .maybeSingle();

    const draft = draftRow?.draft_setup_data ?? {};

    // Merge value into draft
    const updated = { ...draft, [stage]: value };

    // Special promotions
    if (stage === 'business_type') updated.archetype = value;
    if (stage === 'cta_goal')      updated.agent_mode = value === 'support_only' ? 'support' : (draft.agent_mode ?? 'hybrid');
    if (stage === 'tone')          updated.persona = { ...(draft.persona ?? {}), tone: value };
    if (stage === 'response_length') updated.persona = { ...(updated.persona ?? {}), answer_length: value };
    if (stage === 'emoji_usage')   updated.persona = { ...(updated.persona ?? {}), emoji_style: value };
    if (stage === 'escalation')    updated.guardrails = { ...(draft.guardrails ?? {}), escalation_rules: value };

    // Determine next stage
    let next = SETUP_STAGE_FLOW[stage] ?? 'confirm_and_commit';
    if (stage === 'cta_goal' && value === 'support_only') next = 'tone'; // skip push_speed

    // Upsert draft
    await supabase.from('setup_drafts').upsert(
      { session_id, current_setup_stage: next, draft_setup_data: updated, updated_at: new Date().toISOString() },
      { onConflict: 'session_id' }
    );

    // Keep session in sync
    await supabase.from('sessions').upsert(
      { session_id, current_setup_stage: next, session_mode: 'setup' },
      { onConflict: 'session_id' }
    );

    return res.json({ status: 'success', next_stage: next, draft: updated });

  } catch (e) {
    console.error('[setup/save]', e);
    return res.status(500).json({ status: 'error', message: e.message });
  }
});

// ── Setup: commit finalized profile ──────────────────────────────────────────
app.post('/setup/commit', async (req, res) => {
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ status: 'error', message: 'session_id required' });

  try {
    const { supabase } = await import('./lib/supabase.js');

    const { data: draftRow } = await supabase
      .from('setup_drafts')
      .select('draft_setup_data, business_id')
      .eq('session_id', session_id)
      .maybeSingle();

    if (!draftRow) return res.status(404).json({ status: 'error', message: 'No draft found' });

    const d = draftRow.draft_setup_data ?? {};
    const business_id = draftRow.business_id;

    const { error } = await supabase.from('business_profiles').upsert({
      business_id, session_id,
      business_model:        d.archetype ?? null,
      agent_mode:            d.agent_mode ?? 'hybrid',
      cta_goal:              d.cta_goal ?? null,
      push_speed:            d.push_speed ?? 'balanced',
      faq_topics:            d.faq_topics ?? [],
      services:              d.faq_topics ?? [],
      persona:               d.persona ?? {},
      guardrails:            d.guardrails ?? {},
      knowledge:             { faq: d.faq_examples ?? '', objection_handling: d.objections ?? '' },
      setup_completed:       true,
      committed_at:          new Date().toISOString(),
    }, { onConflict: 'business_id' });

    if (error) return res.status(500).json({ status: 'error', message: error.message });

    await supabase.from('sessions').update({ setup_completed: true }).eq('session_id', session_id);

    return res.json({ status: 'success', message: 'Setup complete' });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 8080;
loadAgents().then(() => {
  app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
});

function stub(mode) {
  return { status: 'success', result: { response: `[${mode} agent not yet implemented]`, next_stage: 'stub' } };
}
