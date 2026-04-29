import express from 'express';
import { normalizeMessage } from './lib/normalize.js';
import { loadContext } from './lib/context.js';
import { saveConversation, saveSetupState } from './lib/db.js';
import { startRun, stepStart, stepDone, completeRun } from './lib/logger.js';

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

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 3001;
loadAgents().then(() => {
  app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
});

function stub(mode) {
  return { status: 'success', result: { response: `[${mode} agent not yet implemented]`, next_stage: 'stub' } };
}
