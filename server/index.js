import express from 'express';
import { normalizeMessage } from './lib/normalize.js';
import { loadContext } from './lib/context.js';
import { saveConversation, saveSetupState } from './lib/db.js';
import { startRun, stepStart, stepDone, completeRun } from './lib/logger.js';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'https://multiagent.pages.dev')
  .split(',').map(s => s.trim().replace(/^["']|["']$/g, '').replace(/\/$/, '')); // strip quotes + trailing slash
console.log('[cors] allowed origins:', ALLOWED_ORIGINS);

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
  const allowed = !origin || ALLOWED_ORIGINS.includes(origin);

  // Always set CORS headers — preflight must include them or browser blocks the actual request
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (origin && allowed) res.setHeader('Access-Control-Allow-Origin', origin);

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Client error logger ───────────────────────────────────────────────────────
app.post('/log/error', async (req, res) => {
  const { message, source, stack, url, ts } = req.body ?? {};
  console.error(`[client-error] ${ts} | ${source} | ${message}\n${stack ?? ''}`);
  try {
    const { supabase } = await import('./lib/supabase.js');
    await supabase.from('agent_runs').insert({
      session_id: 'client-error',
      inbound_message: message ?? '(no message)',
      status: 'error',
      error: `[${source}] ${message}`,
      steps: [{ step: 'client_error', status: 'error', source, stack, url, ts }],
      completed_at: new Date().toISOString(),
    });
  } catch {}
  res.json({ ok: true });
});

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

    // Step 2b — Agent activation pre-checks (live mode only)
    if (session_mode === 'live' && business_id) {
      const { supabase } = await import('./lib/supabase.js');
      const { data: profile } = await supabase
        .from('business_profiles')
        .select('agent_active, answer_after_hours, after_hours_message, new_contacts_only, skip_initiated_conversations, working_hours')
        .eq('business_id', business_id)
        .maybeSingle();

      if (profile) {
        if (profile.agent_active === false) {
          await completeRun(run, { skipped: 'agent_inactive' });
          return res.json({ status: 'success', message: '', skipped: true, skip_reason: 'agent_inactive' });
        }

        if (profile.answer_after_hours === false && !isWithinWorkingHours(profile.working_hours)) {
          const msg = profile.after_hours_message || '';
          await completeRun(run, { skipped: 'after_hours' });
          return res.json({ status: 'success', message: msg, skipped: true, skip_reason: 'after_hours' });
        }

        if (profile.new_contacts_only === true) {
          const { count } = await supabase
            .from('conversation_messages')
            .select('id', { count: 'exact', head: true })
            .eq('session_id', session_id)
            .eq('business_id', business_id);
          if (count > 0) {
            await completeRun(run, { skipped: 'known_contact' });
            return res.json({ status: 'success', message: '', skipped: true, skip_reason: 'known_contact' });
          }
        }

        if (profile.skip_initiated_conversations === true) {
          const { data: firstMsg } = await supabase
            .from('conversation_messages')
            .select('user_message')
            .eq('session_id', session_id)
            .eq('business_id', business_id)
            .order('created_at', { ascending: true })
            .limit(1)
            .maybeSingle();
          if (firstMsg && !firstMsg.user_message) {
            await completeRun(run, { skipped: 'business_initiated' });
            return res.json({ status: 'success', message: '', skipped: true, skip_reason: 'business_initiated' });
          }
        }
      }
    }

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

      // Fire FAQ suggest check asynchronously — non-blocking
      if (business_id && message && final_response) {
        checkAndSuggestFaq({ business_id, question: message, answer: final_response }).catch(() => {});
      }

      // Non-blocking contact upsert
      const _contactStatus = r?.cta_triggered ? 'cta_triggered' : 'in_conversation';
      upsertContact({ business_id, phone: session_id, status: _contactStatus, incrementMessage: true }).catch(() => {});

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

// Israeli Yom Tov dates — businesses closed (5785–5786 / 2024–2026)
async function upsertContact({ business_id, phone, status, incrementMessage = false }) {
  if (!business_id || !phone) return;
  try {
    const { supabase } = await import('./lib/supabase.js');
    const now = new Date().toISOString();

    // Check if contact exists
    const { data: existing } = await supabase
      .from('contacts')
      .select('id, message_count, status')
      .eq('business_id', business_id)
      .eq('phone', phone)
      .maybeSingle();

    if (existing) {
      const updates = { last_activity_at: now, updated_at: now };
      if (incrementMessage) updates.message_count = (existing.message_count || 0) + 1;
      // Only upgrade status, never downgrade (new_lead → in_conversation → cta_triggered etc.)
      const statusOrder = ['new_lead','in_conversation','cta_triggered','followup_sent','converted','cold','not_relevant'];
      const currentIdx = statusOrder.indexOf(existing.status);
      const newIdx = statusOrder.indexOf(status);
      if (status && newIdx > currentIdx) updates.status = status;
      await supabase.from('contacts').update(updates).eq('id', existing.id);
    } else {
      await supabase.from('contacts').insert({
        business_id, phone,
        status: status || 'new_lead',
        message_count: incrementMessage ? 1 : 0,
        last_activity_at: now,
      });
    }
  } catch (e) {
    console.error('[upsertContact]', e.message);
  }
}

const JEWISH_HOLIDAYS = new Set([
  '2024-10-02','2024-10-03',                         // Rosh Hashana
  '2024-10-11','2024-10-12',                         // Yom Kippur eve + day
  '2024-10-16','2024-10-17',                         // Sukkot I–II
  '2024-10-23','2024-10-24',                         // Shmini Atzeret + Simchat Torah
  '2025-04-12','2025-04-13','2025-04-18','2025-04-19', // Passover
  '2025-06-01','2025-06-02',                         // Shavuot
  '2025-09-22','2025-09-23',                         // Rosh Hashana
  '2025-10-01','2025-10-02',                         // Yom Kippur eve + day
  '2025-10-06','2025-10-07',                         // Sukkot I–II
  '2025-10-13','2025-10-14',                         // Shmini Atzeret + Simchat Torah
  '2026-04-01','2026-04-02','2026-04-07','2026-04-08', // Passover
  '2026-05-21','2026-05-22',                         // Shavuot
]);

function isWithinWorkingHours(working_hours) {
  if (!working_hours?.days) return true;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));

  // Jewish holiday check — treat as closed day
  if (working_hours.jewish_holidays) {
    const dateStr = now.toISOString().slice(0, 10);
    if (JEWISH_HOLIDAYS.has(dateStr)) return false;
  }

  const dayIdx = now.getDay();
  const cur = now.getHours() * 60 + now.getMinutes();
  const day = working_hours.days[dayIdx];
  if (!day?.active) return false;
  const [fH, fM] = (day.from || '09:00').split(':').map(Number);
  const [tH, tM] = (day.to   || '18:00').split(':').map(Number);
  return cur >= fH * 60 + fM && cur <= tH * 60 + tM;
}

const SETUP_STAGE_FLOW = {
  business_details:    'business_type',
  business_type:       'faq_topics',
  faq_topics:          'cta_goal',
  cta_goal:            'push_speed',   // support_only overrides to 'tone' below
  push_speed:          'tone',
  tone:                'response_length',
  response_length:     'emoji_usage',
  emoji_usage:         'escalation',
  escalation:          'escalation_other',
  escalation_other:    'faq_examples',
  faq_examples:        'objections',
  objections:          'forbidden_claims',
  forbidden_claims:    'final_note',
  final_note:          'working_hours',
  working_hours:       'agent_availability',
  agent_availability:  'confirm_and_commit',
};

app.post('/setup/save', async (req, res) => {
  const { session_id, stage, value } = req.body;
  if (!session_id || !stage || value === undefined) {
    return res.status(400).json({ status: 'error', message: 'session_id, stage, value required' });
  }

  try {
    const { supabase } = await import('./lib/supabase.js');

    // Load current draft + business_id from session
    const [draftRes, sessionRes] = await Promise.all([
      supabase.from('setup_drafts').select('draft_setup_data, current_setup_stage, business_id').eq('session_id', session_id).maybeSingle(),
      supabase.from('sessions').select('business_id').eq('session_id', session_id).maybeSingle(),
    ]);
    const draftRow   = draftRes.data;
    const business_id = draftRow?.business_id ?? sessionRes.data?.business_id ?? null;

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

    // Upsert draft (always persist business_id)
    await supabase.from('setup_drafts').upsert(
      { session_id, business_id, current_setup_stage: next, draft_setup_data: updated, updated_at: new Date().toISOString() },
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
  const { session_id, business_id: req_business_id } = req.body;
  if (!session_id) return res.status(400).json({ status: 'error', message: 'session_id required' });

  try {
    const { supabase } = await import('./lib/supabase.js');

    const [draftRes, sessionRes] = await Promise.all([
      supabase.from('setup_drafts').select('draft_setup_data').eq('session_id', session_id).maybeSingle(),
      supabase.from('sessions').select('business_id').eq('session_id', session_id).maybeSingle(),
    ]);

    if (!draftRes.data) return res.status(404).json({ status: 'error', message: 'No draft found' });

    const d = draftRes.data.draft_setup_data ?? {};
    const business_id = req_business_id || sessionRes.data?.business_id || null;

    if (!business_id) return res.status(400).json({ status: 'error', message: 'business_id not found for this session' });

    const det = d.business_details ?? {};
    const avail = d.agent_availability ?? {};

    const { error } = await supabase.from('business_profiles').upsert({
      business_id,
      session_id,
      business_model:               d.archetype ?? null,
      agent_mode:                   d.agent_mode ?? 'hybrid',
      cta_goal:                     d.cta_goal ?? null,
      push_speed:                   d.push_speed ?? 'balanced',
      faq_topics:                   d.faq_topics ?? [],
      services:                     d.faq_topics ?? [],
      key_questions:                [],
      objection_handling:           [],
      persona:                      d.persona ?? {},
      guardrails:                   d.guardrails ?? {},
      hebrew_patterns:              {},
      draft_setup_data:             d,
      knowledge:                    { faq: Array.isArray(d.faq_pairs) ? d.faq_pairs.map(p => `Q: ${p.q}\nA: ${p.a}`).join('\n\n') : '', objection_handling: d.objections ?? '' },
      working_hours:                d.working_hours ?? null,
      escalation_other:             d.escalation_other ?? null,
      contact_name:                 det.contact_name ?? null,
      contact_phone:                det.contact_phone ?? null,
      contact_email:                det.contact_email ?? null,
      business_category:            det.business_category ?? null,
      agent_active:                 avail.agent_active ?? true,
      answer_after_hours:           avail.answer_after_hours ?? true,
      after_hours_message:          avail.after_hours_message ?? null,
      new_contacts_only:            avail.new_contacts_only ?? false,
      skip_initiated_conversations: avail.skip_initiated_conversations ?? true,
      followup_enabled:             avail.followup_enabled ?? false,
      followup_delay_days:          avail.followup_delay_days ?? 2,
      followup_message:             avail.followup_message ?? null,
      setup_completed:              true,
      committed_at:                 new Date().toISOString(),
    }, { onConflict: 'business_id' });

    if (error) return res.status(500).json({ status: 'error', message: error.message });

    // Sync contact details back to businesses table
    const bizUpdate = {};
    if (det.business_name)     bizUpdate.name = det.business_name;
    if (det.contact_name)      bizUpdate.contact_name = det.contact_name;
    if (det.contact_email)     bizUpdate.contact_email = det.contact_email;
    if (det.contact_phone)     bizUpdate.whatsapp_number = det.contact_phone;
    if (det.business_category) bizUpdate.business_category = det.business_category;
    if (Object.keys(bizUpdate).length) {
      await supabase.from('businesses').update(bizUpdate).eq('id', business_id);
    }

    await supabase.from('sessions').update({ setup_completed: true, session_mode: 'live' }).eq('session_id', session_id);

    return res.json({ status: 'success', message: 'Setup complete' });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: e.message });
  }
});

// ── Business preferences update ──────────────────────────────────────────────
app.post('/business/update', async (req, res) => {
  const { business_id, updates } = req.body ?? {};
  if (!business_id || !updates) return res.status(400).json({ status: 'error', message: 'business_id and updates required' });

  try {
    const { supabase } = await import('./lib/supabase.js');
    const { error } = await supabase
      .from('business_profiles')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('business_id', business_id);
    if (error) return res.status(500).json({ status: 'error', message: error.message });
    return res.json({ status: 'success' });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: e.message });
  }
});

// ── Business: toggle agent active ────────────────────────────────────────────
app.post('/business/toggle-active', async (req, res) => {
  const { business_id, active } = req.body ?? {};
  if (!business_id || typeof active !== 'boolean')
    return res.status(400).json({ status: 'error', message: 'business_id and active (boolean) required' });
  try {
    const { supabase } = await import('./lib/supabase.js');
    const { error } = await supabase
      .from('business_profiles')
      .update({ agent_active: active })
      .eq('business_id', business_id);
    if (error) return res.status(500).json({ status: 'error', message: error.message });
    return res.json({ status: 'success', agent_active: active });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: e.message });
  }
});

// ── FAQ suggest — check similarity and insert candidate ──────────────────────
async function checkAndSuggestFaq({ business_id, question, answer }) {
  try {
    const { supabase } = await import('./lib/supabase.js');
    const { data: existing } = await supabase
      .from('knowledge_items')
      .select('question')
      .eq('business_id', business_id);

    if (existing?.length) {
      const inWords = question.toLowerCase().split(/\s+/).filter(w => w.length > 1);
      const threshold = Math.ceil(inWords.length * 0.4);
      const match = existing.some(row => {
        const rowQ = row.question.toLowerCase();
        const overlap = inWords.filter(w => rowQ.includes(w)).length;
        return overlap >= threshold;
      });
      if (match) return { suggested: false };
    }

    const { data: inserted } = await supabase
      .from('knowledge_items')
      .insert({
        business_id,
        category: 'general',
        question,
        answer,
        is_active: false,
        suggested: true,
        language: 'he',
      })
      .select('id')
      .maybeSingle();

    return { suggested: true, item_id: inserted?.id ?? null };
  } catch (e) {
    console.error('[faq/suggest] error:', e.message);
    return { suggested: false };
  }
}

app.post('/faq/suggest', async (req, res) => {
  const { business_id, session_id, question, answer } = req.body ?? {};
  if (!business_id || !question) {
    return res.status(400).json({ status: 'error', message: 'business_id and question required' });
  }
  const result = await checkAndSuggestFaq({ business_id, question, answer: answer ?? '' });
  return res.json({ status: 'success', ...result });
});

// ── Knowledge sync — rebuild knowledge field from active FAQ items ─────────────
app.post('/knowledge/sync', async (req, res) => {
  const { business_id } = req.body ?? {};
  if (!business_id) return res.status(400).json({ status: 'error', message: 'business_id required' });

  try {
    const { supabase } = await import('./lib/supabase.js');

    const { data: items } = await supabase
      .from('knowledge_items')
      .select('question, answer, category')
      .eq('business_id', business_id)
      .eq('is_active', true)
      .order('category');

    if (!items?.length) return res.json({ status: 'success', synced: 0 });

    // Build structured knowledge summary the agent can read
    const grouped = items.reduce((acc, item) => {
      if (!acc[item.category]) acc[item.category] = [];
      if (item.answer) acc[item.category].push(`Q: ${item.question}\nA: ${item.answer}`);
      return acc;
    }, {});

    const knowledge_summary = Object.entries(grouped)
      .map(([cat, qs]) => `[${cat}]\n${qs.join('\n\n')}`)
      .join('\n\n---\n\n');

    await supabase
      .from('business_profiles')
      .update({
        knowledge: { ...{}, faq_summary: knowledge_summary, synced_at: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      })
      .eq('business_id', business_id);

    return res.json({ status: 'success', synced: items.length });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: e.message });
  }
});

// ── Follow-up processor ───────────────────────────────────────────────────────
// Called by external cron (e.g. cron-job.org hitting POST /follow-up/process)
// Finds eligible stale leads and logs a follow-up (WA send = stub until real API)
app.post('/follow-up/process', async (req, res) => {
  const { business_id: target } = req.body ?? {};
  try {
    const { supabase } = await import('./lib/supabase.js');
    const now = new Date();

    // Load businesses with follow-ups enabled
    let q = supabase
      .from('business_profiles')
      .select('business_id, followup_delay_days, followup_message')
      .eq('followup_enabled', true)
      .eq('agent_active', true);
    if (target) q = q.eq('business_id', target);
    const { data: businesses } = await q;
    if (!businesses?.length) return res.json({ status: 'success', processed: 0, results: [] });

    const results = [];

    for (const biz of businesses) {
      const delayDays = biz.followup_delay_days ?? 2;
      const cutoff = new Date(now);
      cutoff.setDate(cutoff.getDate() - delayDays);

      // Get live sessions for this business
      const { data: sessions } = await supabase
        .from('sessions')
        .select('session_id')
        .eq('business_id', biz.business_id)
        .eq('session_mode', 'live')
        .eq('setup_completed', true);

      for (const { session_id } of sessions ?? []) {
        // Skip if follow-up already recorded
        const { data: existing } = await supabase
          .from('lead_followups')
          .select('id')
          .eq('business_id', biz.business_id)
          .eq('session_id', session_id)
          .maybeSingle();
        if (existing) { results.push({ session_id, skipped: 'already_processed' }); continue; }

        // Get last user message
        const { data: lastMsg } = await supabase
          .from('conversation_messages')
          .select('created_at')
          .eq('session_id', session_id)
          .eq('business_id', biz.business_id)
          .not('user_message', 'is', null)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!lastMsg) { results.push({ session_id, skipped: 'no_user_messages' }); continue; }

        // Skip if CTA already triggered
        const { count: ctaCount } = await supabase
          .from('conversation_messages')
          .select('id', { count: 'exact', head: true })
          .eq('session_id', session_id)
          .eq('business_id', biz.business_id)
          .eq('cta_triggered', true);
        if (ctaCount > 0) { results.push({ session_id, skipped: 'cta_triggered' }); continue; }

        // Skip if last message is too recent
        if (new Date(lastMsg.created_at) > cutoff) {
          results.push({ session_id, skipped: 'too_recent' }); continue;
        }

        // Eligible — log follow-up
        const message = biz.followup_message?.trim() || 'היי! רק רציתי לבדוק אם יש לך שאלות נוספות 😊';
        const scheduledFor = new Date(lastMsg.created_at);
        scheduledFor.setDate(scheduledFor.getDate() + delayDays);

        await supabase.from('lead_followups').upsert({
          business_id:   biz.business_id,
          session_id,
          status:        'sent', // future: 'pending' → send via WA API → update to 'sent'
          message,
          scheduled_for: scheduledFor.toISOString(),
          sent_at:       now.toISOString(),
          // TODO: replace with real WA Business API send when integration is live
        }, { onConflict: 'business_id,session_id' });

        upsertContact({ business_id: biz.business_id, phone: session_id, status: 'followup_sent' }).catch(() => {});

        results.push({ session_id, status: 'sent', message });
      }
    }

    const sent    = results.filter(r => r.status === 'sent').length;
    const skipped = results.filter(r => r.skipped).length;
    return res.json({ status: 'success', processed: results.length, sent, skipped, results });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: e.message });
  }
});

// ── Contacts ──────────────────────────────────────────────────────────────────
app.get('/contacts/:business_id', async (req, res) => {
  const { business_id } = req.params;
  const { status, limit = 50, offset = 0 } = req.query;
  try {
    const { supabase } = await import('./lib/supabase.js');
    let q = supabase
      .from('contacts')
      .select('id, phone, name, status, notes, ai_summary, message_count, last_activity_at, created_at')
      .eq('business_id', business_id)
      .order('last_activity_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) return res.status(500).json({ status: 'error', message: error.message });
    return res.json({ status: 'success', contacts: data || [] });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: e.message });
  }
});

app.patch('/contacts/:id', async (req, res) => {
  const { id } = req.params;
  const { name, notes, status } = req.body ?? {};
  try {
    const { supabase } = await import('./lib/supabase.js');
    const updates = { updated_at: new Date().toISOString() };
    if (name !== undefined) updates.name = name;
    if (notes !== undefined) updates.notes = notes;
    if (status !== undefined) updates.status = status;
    const { error } = await supabase.from('contacts').update(updates).eq('id', id);
    if (error) return res.status(500).json({ status: 'error', message: error.message });
    return res.json({ status: 'success' });
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
