import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { studioAuth } from './lib/auth.js';
import { normalizeMessage, extractMessageText } from './lib/normalize.js';
import { loadContext } from './lib/context.js';
import { saveConversation, saveSetupState } from './lib/db.js';
import { startRun, stepStart, stepDone, completeRun } from './lib/logger.js';
import { sendWhatsAppMessage, sendWhatsAppTemplate } from './lib/wa-send.js';
import { verifyMetaSignature, classifyMetaPayload, seenMessage, sendUnsupportedFallback } from './lib/wa-webhook.js';
import { handlePaymentProofImage } from './lib/payment-proof.js';
import { JEWISH_HOLIDAYS } from './lib/holidays.js';
import { buildModulesContext } from './lib/modules/engine.js';
import { runModuleActionStep } from './lib/module-action-step.js';
import { warnOnIncompleteBoosterEnv } from './lib/booster-client.js';
import { extractReferral, recordCtwaReferral } from './lib/ctwa.js';
import { runFollowUpsAndNudges } from './lib/followup-orchestrator.js';
import { healthPayload } from './lib/health.js';
import dataRouter from './routes/data.js';
import oauthRouter from './routes/oauth.js';
import boosterWebhookRouter from './routes/booster-webhook.js';
import meetingApprovalRouter from './routes/meeting-approval.js';
import processApprovalRouter from './routes/process-approval.js';
import onboardRouter from './routes/onboard.js';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'https://multiagent.pages.dev')
  .split(',').map(s => s.trim().replace(/^["']|["']$/g, '').replace(/\/$/, '')); // strip quotes + trailing slash
console.log('[cors] allowed origins:', ALLOWED_ORIGINS);

// Agents — imported lazily so missing files don't crash startup
let runConversation = null, runSetup = null, runLearning = null;
async function loadAgents() {
  const [conv, setup, demo] = await Promise.all([
    import('./agents/conversation.js').catch(e => { console.error('[loadAgents] conversation:', e.message); return {}; }),
    import('./agents/setup.js').catch(e => { console.error('[loadAgents] setup:', e.message); return {}; }),
    import('./agents/demo.js').catch(e => { console.error('[loadAgents] demo:', e.message); return {}; }),
  ]);
  runConversation = conv.runConversation ?? null;
  runSetup        = setup.runSetup ?? null;
  runLearning     = demo.runDemo ?? null;
  console.log('[loadAgents] runConversation:', typeof runConversation, '| runSetup:', typeof runSetup, '| runDemo:', typeof runLearning);
}

const app = express();
app.set('trust proxy', 1); // Railway sits behind a proxy — needed for real client IPs
app.use(helmet());
// rawBody is needed for Meta's X-Hub-Signature-256 HMAC validation
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

// Rate limiting (SECURITY_AUDIT_SPEC D-02): generous global ceiling, a
// higher lane for the Meta webhook, and strict brute-force protection on
// the portal login.
app.use('/wa-inbound', rateLimit({ windowMs: 15 * 60 * 1000, max: 1800, standardHeaders: true, legacyHeaders: false }));
app.use('/portal/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'יותר מדי ניסיונות התחברות — נסו שוב בעוד רבע שעה' } }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false,
  skip: (req) => req.path === '/wa-inbound' }));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = !origin || ALLOWED_ORIGINS.includes(origin);

  // Always set CORS headers — preflight must include them or browser blocks the actual request
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (origin && allowed) res.setHeader('Access-Control-Allow-Origin', origin);

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Operator auth — everything below except the declared public surface
// (flag-gated via STUDIO_AUTH_REQUIRED; see lib/auth.js)
app.use(studioAuth);

// ── Data proxy (replaces direct anon Supabase calls from the frontend) ────────
app.use('/data', dataRouter);
app.use(oauthRouter);
app.use(boosterWebhookRouter);
app.use(meetingApprovalRouter);
app.use(processApprovalRouter);
app.use('/onboard', onboardRouter);

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json(healthPayload()));

// Sits behind studioAuth (not in PUBLIC_PATHS) — the frontend login screen
// calls it with a candidate key to validate before storing it.
app.get('/auth/check', (_req, res) =>
  res.json({ ok: true, enforced: process.env.STUDIO_AUTH_REQUIRED === 'true' }));

// ── Studio RPC — whitelisted DB ops for the wa-studio frontend ────────────────
app.post('/studio/rpc', async (req, res) => {
  const { fn, args } = req.body ?? {};
  try {
    const { runStudioOp } = await import('./lib/studio.js');
    const result = await runStudioOp(fn, args);
    res.json({ ok: true, result: result ?? null });
  } catch (e) {
    console.error(`[studio] ${fn} failed:`, e.message);
    res.status(e.status ?? 500).json({ ok: false, error: e.message });
  }
});

// ── Client portal: login + business-scoped RPC ────────────────────────────────
app.post('/portal/login', async (req, res) => {
  try {
    const { portalLogin } = await import('./lib/portal.js');
    const result = await portalLogin(req.body?.email, req.body?.password);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status ?? 500).json({ ok: false, error: e.message });
  }
});

app.post('/portal/rpc', async (req, res) => {
  try {
    const { verifyToken, runPortalOp } = await import('./lib/portal.js');
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const payload = verifyToken(token);
    if (!payload) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const { fn, args } = req.body ?? {};
    const result = await runPortalOp(payload.business_id, fn, args);
    res.json({ ok: true, result: result ?? null });
  } catch (e) {
    console.error(`[portal] ${req.body?.fn} failed:`, e.message);
    res.status(e.status ?? 500).json({ ok: false, error: e.message });
  }
});

// ── Leads CSV export (ניהול לידים — the Google Sheet replacement) ─────────────
// Same signed-token auth as /portal/rpc; a GET so the response is a real file.
// The portal UI fetches it with the Authorization header and hands the bytes
// to a Blob download, so no token ever rides a query string. Hebrew headers +
// UTF-8 BOM come from lib/leads.js#leadsToCsv.
app.get('/portal/leads.csv', async (req, res) => {
  try {
    const { verifyToken } = await import('./lib/portal.js');
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const payload = verifyToken(token);
    if (!payload) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const { exportLeadsCsv } = await import('./lib/leads.js');
    const { filename, csv } = await exportLeadsCsv(payload.business_id);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (e) {
    console.error('[portal] leads.csv failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

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

// ── WhatsApp webhook verification (Meta calls this GET to confirm the URL) ────
app.get('/wa-inbound', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    return res.send(challenge);
  }
  res.status(403).send('Forbidden');
});

// ── Inbound WhatsApp webhook ──────────────────────────────────────────────────
// Meta payloads: validate signature, ack 200 immediately (Meta retries slow
// webhooks, causing duplicate replies), then run the pipeline detached.
// Studio's direct {message, session_id} format stays synchronous — the UI
// reads the reply from the HTTP response.
app.post('/wa-inbound', async (req, res) => {
  if (req.body?.object === 'whatsapp_business_account') {
    if (!verifyMetaSignature(req)) {
      return res.status(403).json({ status: 'error', message: 'invalid signature' });
    }
    const { kind, msgId, value, echo } = classifyMetaPayload(req.body);
    if (kind === 'ignore') return res.json({ status: 'ignored' });
    if (seenMessage(msgId)) return res.json({ status: 'duplicate' });

    // Auto-reply immunity bookkeeping (lib/coexistence.js): remember WHEN this
    // customer last wrote to this number, so an echo landing within the grace
    // window reads as the app's automatic greeting, not the owner personally
    // answering. After the dedup check — a Meta retry is not a new message.
    if (kind === 'message' || kind === 'unsupported') {
      import('./lib/coexistence.js')
        .then(({ noteCustomerInbound }) => noteCustomerInbound({
          phoneNumberId: value?.metadata?.phone_number_id,
          from: value?.messages?.[0]?.from,
        }))
        .catch(() => {});
    }

    // Coexistence echo — the OWNER's own message, mirrored to us by Meta.
    // Never a customer message: no pipeline, no lead capture, no reply. For a
    // coexistence business it arms the per-conversation owner standdown
    // (lib/coexistence.js); for everyone else it is a plain ack.
    if (kind === 'echo') {
      res.json({ status: 'echo' });
      import('./lib/coexistence.js')
        .then(({ handleOwnerEcho }) => handleOwnerEcho(echo))
        .catch(e => console.error('[wa-inbound] echo handling failed:', e.message));
      return;
    }

    res.json({ status: 'received' }); // fast-ack before any processing
    if (kind === 'unsupported') {
      // Task 17: an image from a sender mid-payment is a payment-proof
      // screenshot, not just "unsupported media" — handlePaymentProofImage
      // claims that case (forward + its own reply) and returns true; anything
      // else (non-image, or a sender not in a payment-stage status) falls
      // through to today's generic fallback, unchanged.
      //
      // Coexistence: during an owner standdown even the "text only please"
      // fallback must stay silent — the owner is personally handling this
      // conversation. standdownActive fails soft to false, so every
      // non-coexistence tenant keeps today's behaviour exactly.
      (async () => {
        const { standdownActive } = await import('./lib/coexistence.js');
        // Scoped to the business that owns the receiving number — a standdown
        // on the same phone's conversation with ANOTHER tenant's bot must not
        // silence this one (one phone can talk to two coexistence tenants).
        if (await standdownActive(value?.messages?.[0]?.from,
          { phoneNumberId: value?.metadata?.phone_number_id })) return;
        const handled = await handlePaymentProofImage(value)
          .catch(e => { console.error('[wa-inbound] payment-proof handling failed:', e.message); return false; });
        if (!handled) sendUnsupportedFallback(value).catch(() => {});
      })().catch(e => console.error('[wa-inbound] unsupported handling failed:', e.message));
      return;
    }

    // A message from a listed business contact (rep or owner) answering an
    // escalation must never reach the conversation agent — recognise it here,
    // scoped to the business that owns the receiving number, before the
    // pipeline (and its own contacts-table upsert) ever runs.
    // FAILS CLOSED — see lib/relay/intercept.js. Anything short of a clean
    // "this sender is not a listed contact of this business" stops here rather
    // than reaching the conversation agent.
    try {
      const { interceptContactMessage } = await import('./lib/relay/intercept.js');
      const consumed = await interceptContactMessage({
        phoneNumberId: value?.metadata?.phone_number_id,
        from: value.messages[0].from,
        // text/interactive/button all classify as kind:'message' — read it the
        // same way normalizeMessage does so a rep's button tap (Task 10 moved
        // the rep hop to templates) doesn't relay as "".
        text: extractMessageText(value.messages[0]),
        contextId: value.messages[0].context?.id ?? null,
      });
      if (consumed) return; // never reaches the conversation agent, no contacts row
    } catch (e) {
      console.error('[wa-inbound] contact gate failed — not running the pipeline for an unverified sender:', e.message);
      return;
    }

    runAgentPipeline(req.body).catch(e => console.error('[wa-inbound] async pipeline failed:', e));
    return;
  }

  const out = await runAgentPipeline(req.body);
  return res.status(out.http).json(out.body);
});

async function runAgentPipeline(body) {
  const run = await startRun({ session_id: 'unknown', inbound_message: '[pending]' });

  try {
    // Step 1 — Normalize
    let h = stepStart(run, 'normalize', { body });
    const normalized = normalizeMessage(body);
    await stepDone(h, normalized);

    if (normalized.status !== 'success') {
      await completeRun(run, { error: normalized.error });
      return { http: 400, body: { status: 'error', message: normalized.error } };
    }

    const { message, session_id, phone_number_id, profile_name } = normalized.result;
    run.session_id = session_id;

    // Step 2 — Load context
    h = stepStart(run, 'load_context', { session_id });
    const ctx = await loadContext({ message, session_id, phone_number_id });
    await stepDone(h, ctx);

    if (ctx.status !== 'success') {
      await completeRun(run, { error: ctx.error });
      return { http: 500, body: { status: 'error', message: ctx.error } };
    }

    const context = ctx.result;
    const { session_mode, business_id } = context;
    run.business_id = business_id;

    // Step 2a — Meta Click-to-WhatsApp attribution (funnel entry).
    //
    // The ad identity rides on the FIRST inbound message of the conversation
    // and never again, while the lead is created many turns later — so it is
    // banked here and read back at create_quote_lead time (lib/ctwa.js).
    //
    // THIS SITS ABOVE THE STEP 2b GATES ON PURPOSE — do not "tidy" it down
    // next to the other module work. Every one of those pre-checks returns
    // straight out of the pipeline, and they fire exactly when ad traffic
    // does: answer_after_hours kills evening and night clicks, which is when
    // people actually tap ads. Capturing is pure data preservation with no
    // customer-visible effect, so it must happen whether or not the bot goes
    // on to reply. A referral we banked but didn't answer is recoverable; one
    // we never wrote is gone forever.
    //
    // The earliest it CAN sit: business_id and session_id are both resolved
    // one line above, and module_events.business_id is NOT NULL.
    // extractReferral is pure and returns null for ordinary messages, so the
    // ~99% path never reaches the database. Fire-and-forget: a reply must
    // never wait on an attribution write, nor fail because of one.
    //
    // KNOWN ACCEPTED GAP: only the /wa-inbound paths that reach this pipeline
    // are covered. The `kind === 'unsupported'` early return above (image,
    // sticker, audio, ...) never gets here, so a conversation whose very first
    // message is non-text loses its referral. CTWA opens with a prefilled text
    // message, so this is rare, and it is deliberately not built for. The
    // relay contact-intercept return is not a gap — a listed business contact
    // is never an ad click.
    if (session_mode === 'live' && business_id) {
      const referral = extractReferral(body);
      if (referral) {
        recordCtwaReferral({ businessId: business_id, phone: session_id, referral }).catch(() => {});
      }
    }

    // Step 2a¼ — Leads-module bookkeeping (live mode only, fire-and-forget).
    //
    // Same data-first rationale as the CTWA banking directly above, so it sits
    // at the same altitude: the ניהול לידים board must show EVERY number that
    // wrote in, whether or not the bot goes on to reply — after-hours, agent
    // off, and the owner standdown all silence the bot below this line, and
    // none of them may make a lead invisible to the client. First message
    // creates the lead as 'new'; every message refreshes the last-contact
    // bookkeeping. recordInboundMessage gates itself on the business having
    // the `leads` module enabled and FAILS SOFT (lib/leads.js) — a tenant
    // without the module, or a database without the table yet, is untouched
    // and the reply never waits on the write.
    if (session_mode === 'live' && business_id) {
      import('./lib/leads.js')
        .then(({ recordInboundMessage }) => recordInboundMessage({
          businessId: business_id, phone: session_id, profileName: profile_name,
        }))
        .catch(e => console.error('[leads] inbound hook failed:', e.message));
    }

    // Step 2a½ — Coexistence owner standdown (live mode only).
    //
    // The owner answered this conversation personally from the WhatsApp
    // Business app (an echo armed sessions.coexistence_standdown_until), so
    // the bot says NOTHING until it expires. The message is still LOGGED into
    // conversation history and still feeds the lead bookkeeping — the contact
    // upsert (the client-facing lead inbox) and the billing event — exactly so
    // that the owner going hands-on never makes a lead disappear from the
    // board. Sits ABOVE the 2b gates: this is a stronger silence than
    // after-hours and must not be re-answered by any of them; sits BELOW the
    // CTWA banking for the same reason that does — data first.
    //
    // standdownActive fails soft to false (lib/coexistence.js), so tenants
    // without the flag — and a DB without the column — are untouched.
    if (session_mode === 'live' && business_id) {
      const { standdownActive } = await import('./lib/coexistence.js');
      if (await standdownActive(session_id, { businessId: business_id })) {
        const { supabase } = await import('./lib/supabase.js');
        await supabase.from('conversation_messages').insert({
          session_id, business_id, user_message: message, agent_response: '',
          stage: 'coexistence_standdown', action: 'none',
          qualification_progress: context.qualification_progress ?? {},
          cta_triggered: false, escalate: false, language: 'hebrew',
        }).then(({ error }) => { if (error) console.error('[coexistence] standdown log failed:', error.message); });
        upsertContact({ business_id, phone: session_id, status: 'in_conversation', incrementMessage: true }).catch(() => {});
        logBillingEvent({ business_id, session_id, type: 'user_initiated' }).catch(() => {});
        await completeRun(run, { skipped: 'coexistence_standdown' });
        return { http: 200, body: { status: 'success', message: '', skipped: true, skip_reason: 'coexistence_standdown' } };
      }
    }

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
          return { http: 200, body: { status: 'success', message: '', skipped: true, skip_reason: 'agent_inactive' } };
        }

        if (profile.answer_after_hours === false && !isWithinWorkingHours(profile.working_hours)) {
          const msg = profile.after_hours_message || '';
          await completeRun(run, { skipped: 'after_hours' });
          if (msg && session_id && business_id) {
            sendWhatsAppMessage({ to: session_id, text: msg, businessId: business_id }).catch(() => {});
          }
          return { http: 200, body: { status: 'success', message: msg, skipped: true, skip_reason: 'after_hours' } };
        }

        if (profile.new_contacts_only === true) {
          const { count } = await supabase
            .from('conversation_messages')
            .select('id', { count: 'exact', head: true })
            .eq('session_id', session_id)
            .eq('business_id', business_id);
          if (count > 0) {
            await completeRun(run, { skipped: 'known_contact' });
            return { http: 200, body: { status: 'success', message: '', skipped: true, skip_reason: 'known_contact' } };
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
            return { http: 200, body: { status: 'success', message: '', skipped: true, skip_reason: 'business_initiated' } };
          }
        }
      }
    }

    // Step 2c — Modules context (live mode only, non-fatal)
    if (session_mode === 'live' && business_id) {
      try {
        context.modules_context = await buildModulesContext(
          { id: business_id, name: context.business_profile?.business_name ?? '' },
          { session_id }); // who is talking — status-aware modules (booster) need it
      } catch (e) { console.error('[modules] context failed:', e.message); }
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
      return { http: 500, body: { status: 'error', message: agentResult.error } };
    }

    const r = agentResult.result;
    const final_response = r?.response ?? r?.setup_response ?? '';

    // Execute a module action the model requested (live mode only). The
    // server is the only side-effect executor — the model just asks.
    //
    // T7 (funnel track 1): calendar bookings pass the express one-meeting gate
    // first (lib/booster-meeting.js). A block REPLACES the whole reply with
    // the fixed line and relays to Diva; an allowed express booking carries
    // the characterization-meeting title through sessionCtx and, on success,
    // is noted as meeting_booked (blocks a second one — F7 — and suppresses
    // the booster's 3-day reminder — F2).
    let moduleStep = { text: final_response, moduleText: null, blocked: false, booking: null };
    if (session_mode === 'live' && business_id && r?.module_action) {
      h = stepStart(run, 'module_action', { action: r.module_action });
      moduleStep = await runModuleActionStep({
        business: { id: business_id, name: context.business_profile?.business_name ?? '' },
        action: r.module_action,
        session_id,
        profile_name,
        question: message,
        history: context.conversation_history,
        persona: context.persona,
        finalResponse: final_response,
      });
      await stepDone(h, moduleStep.blocked
        ? { blocked: true, text: moduleStep.text }
        : { text: moduleStep.moduleText });
    }
    const outbound_response = moduleStep.text;

    // Step 4 — Persist state
    if (session_mode === 'live') {
      h = stepStart(run, 'save_conversation', {});
      const saved = await saveConversation({
        session_id, business_id,
        user_message: message, agent_response: outbound_response,
        stage: r.next_stage, action: r.action,
        qualification_progress: r.qualification_progress,
        cta_triggered: r.cta_triggered, escalate: r.escalate,
        escalation_reason: r.escalation_reason, language: r.language,
      });
      await stepDone(h, saved);

      // Fire FAQ suggest check asynchronously — non-blocking
      if (business_id && message && outbound_response) {
        checkAndSuggestFaq({ business_id, question: message, answer: outbound_response }).catch(() => {});
      }

      // Send reply back to WhatsApp user. Re-checked against the coexistence
      // standdown at the last moment: the human-typing delay plus generation
      // gives the owner a real window to answer from the app first, and a
      // queued bot reply landing seconds after the owner's own message is
      // exactly what the standdown exists to prevent. For every business
      // without the flag the check resolves false and the send is unchanged.
      if (outbound_response && session_id && business_id) {
        import('./lib/coexistence.js')
          .then(({ sendUnlessStoodDown }) => sendUnlessStoodDown(session_id, business_id, () =>
            sendWhatsAppMessage({ to: session_id, text: outbound_response, businessId: business_id })))
          .catch(e => console.error('[wa-send] non-blocking send failed:', e.message));
      }

      // Non-blocking contact upsert + AI summary. The CRM status comes from
      // the same structured booking result the notes do — a request still
      // awaiting Diva's approval is not a booked meeting on her board either.
      const _confirmedBooking = moduleStep.booking?.ok === true && !moduleStep.booking.tentative;
      const _contactStatus = _confirmedBooking ? 'meeting_booked'
        : r?.cta_triggered ? 'cta_triggered' : 'in_conversation';
      upsertContact({ business_id, phone: session_id, status: _contactStatus, incrementMessage: true }).catch(() => {});
      generateContactSummary({ business_id, phone: session_id, session_id }).catch(() => {});
      logBillingEvent({ business_id, session_id, type: 'user_initiated' }).catch(() => {});

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

    await completeRun(run, { final_response: outbound_response, session_mode });

    return {
      http: 200,
      body: {
        status: 'success',
        message: outbound_response,
        state: {
          session_id,
          stage: r?.next_setup_stage ?? r?.next_stage ?? context.current_stage,
        },
        // The operator-facing wizards drive their progress, completion and
        // activation UI off the agent's own result. Live replies deliberately
        // do not carry it — /wa-inbound is the public Meta webhook and the
        // conversation result holds internal qualification/escalation state.
        ...(session_mode === 'live' ? {} : { result: r }),
      },
    };

  } catch (e) {
    console.error('[orchestrator] unhandled error:', e);
    await completeRun(run, { error: e.message });
    return { http: 500, body: { status: 'error', message: 'Internal server error' } };
  }
}

// ── Billing event logger ──────────────────────────────────────────────────────
async function logBillingEvent({ business_id, session_id, type = 'user_initiated' }) {
  if (!business_id || !session_id) return;
  try {
    const { supabase } = await import('./lib/supabase.js');
    const windowDate = new Date().toISOString().slice(0, 10);
    await supabase.from('wa_billing_events').upsert(
      { business_id, session_id, type, window_date: windowDate },
      { onConflict: 'business_id,session_id,window_date', ignoreDuplicates: true }
    );
  } catch (e) {
    console.error('[logBillingEvent]', e.message);
  }
}

// ── Contact AI summary — runs async after each live exchange ─────────────────
async function generateContactSummary({ business_id, phone, session_id }) {
  if (!business_id || !phone || !session_id) return;
  try {
    const { supabase } = await import('./lib/supabase.js');

    // Need at least 2 messages to summarize
    const { data: messages } = await supabase
      .from('conversation_messages')
      .select('user_message, agent_response')
      .eq('session_id', session_id)
      .eq('business_id', business_id)
      .order('created_at', { ascending: false })
      .limit(10);

    if (!messages || messages.length < 2) return;

    const convoText = [...messages].reverse().map(m => {
      const parts = [];
      if (m.user_message)   parts.push(`לקוח: ${m.user_message}`);
      if (m.agent_response) parts.push(`סוכן: ${m.agent_response}`);
      return parts.join('\n');
    }).join('\n\n');

    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      messages: [{
        role: 'user',
        content: `בהתבסס על השיחה הבאה עם ליד, כתוב סיכום של משפט עד שניים בעברית: מה הליד רוצה, איפה הוא עומד, מה קרה עד כה. בגוף שלישי, ישיר ותמציתי. ללא כותרות, ללא markdown — טקסט בלבד.

${convoText}

סיכום (טקסט בלבד):`
      }]
    });

    const summary = res.content[0]?.text?.trim();
    if (!summary) return;

    await supabase
      .from('contacts')
      .update({ ai_summary: summary, updated_at: new Date().toISOString() })
      .eq('business_id', business_id)
      .eq('phone', phone);

  } catch (e) {
    console.error('[generateContactSummary]', e.message);
  }
}

// ── Setup: direct structured save (no LLM) ───────────────────────────────────
// Used by the wizard for clickable stages — fast, no Claude call needed

// Israeli Yom Tov dates — businesses closed (5785–5786 / 2024–2026)
async function upsertContact({ business_id, phone, status, incrementMessage = false }) {
  if (!business_id || !phone) return;
  // Studio/test sessions use synthetic session ids — only real phone numbers
  // become contacts in the client-facing lead inbox.
  if (!/^\d{10,15}$/.test(String(phone))) return;
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
      // Advances the ladder, never downgrades, and never erases a status a
      // human chose (see lib/contact-status.js).
      const { nextStatus } = await import('./lib/contact-status.js');
      const advanced = nextStatus(existing.status, status);
      if (advanced) updates.status = advanced;
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

// (moved to lib/holidays.js — shared with the calendar module)

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
  const inRange = (from, to) => {
    const [fH, fM] = (from || '09:00').split(':').map(Number);
    const [tH, tM] = (to   || '18:00').split(':').map(Number);
    return cur >= fH * 60 + fM && cur <= tH * 60 + tM;
  };
  if (inRange(day.from, day.to)) return true;
  // Optional second range — e.g. a midday break splits the day in two
  if (day.from2 && day.to2) return inRange(day.from2, day.to2);
  return false;
}

const SETUP_STAGE_FLOW = {
  business_details:    'business_type',
  business_type:       'business_category',
  business_category:   'faq_topics',
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

    // Keep session in sync. Update-then-insert, not upsert-on-session_id: the
    // 2026-08-13 migration drops the session_id-only unique constraint
    // (sessions become per (session_id, business_id)) and ON CONFLICT
    // (session_id) would then have no backing index. Setup sessions are
    // synthetic single-row studio ids — the session_id-scoped update is exact
    // under both schemas.
    const sessionPatch = { session_id, current_setup_stage: next, session_mode: 'setup' };
    const { data: sessRows } = await supabase.from('sessions')
      .update(sessionPatch).eq('session_id', session_id).select('session_id');
    if (!sessRows?.length) {
      await supabase.from('sessions').insert(sessionPatch);
    }

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

    // The stale-lead follow-up sweep (gated by followup_enabled, per business)
    // and the rep-nudge pass (human-rep-relay Task 8, gated only by an open
    // escalation existing) are unrelated features sharing this scheduling
    // slot. followup_enabled must never gate nudges — see
    // runFollowUpsAndNudges for why this is structured as two independent
    // halves rather than the nudge call sitting after a follow-up early
    // return. Nothing schedules /follow-up/process today (no cron, no
    // setInterval; see CLAUDE.md / the relay design doc §9) — this is where
    // a future scheduler attaches, and it must not gain a second one of its
    // own.
    const { results, nudges } = await runFollowUpsAndNudges({
      businesses,
      runFollowUps: async (list) => {
        const results = [];
        for (const biz of list) {
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

            // A follow-up is by definition outside the 24h customer-service window,
            // so business-initiated sends must use an approved template.
            const templateName = process.env.WHATSAPP_FOLLOWUP_TEMPLATE || null;
            let wa_send = 'not_configured';
            if (templateName) {
              const sent = await sendWhatsAppTemplate({ to: session_id, templateName, businessId: biz.business_id });
              wa_send = sent?.messages?.[0]?.id ? 'sent' : 'send_failed';
            }

            await supabase.from('lead_followups').upsert({
              business_id:   biz.business_id,
              session_id,
              status:        'sent',
              message,
              scheduled_for: scheduledFor.toISOString(),
              sent_at:       now.toISOString(),
            }, { onConflict: 'business_id,session_id' });

            upsertContact({ business_id: biz.business_id, phone: session_id, status: 'followup_sent' }).catch(() => {});
            logBillingEvent({ business_id: biz.business_id, session_id, type: 'business_initiated' }).catch(() => {});

            results.push({ session_id, status: 'sent', wa_send, message });
          }
        }
        return results;
      },
      runNudges: async () => {
        const { nudgePass } = await import('./lib/relay/index.js');
        return nudgePass({
          isOpenNow: async (businessId) => {
            const { data } = await supabase.from('business_profiles')
              .select('working_hours').eq('business_id', businessId).maybeSingle();
            return isWithinWorkingHours(data?.working_hours);
          },
          // nudgePass caches this per business_id itself — one query per
          // business per pass, not one per open escalation.
          getNudgeSettings: async (businessId) => {
            const { data } = await supabase.from('business_profiles')
              .select('nudge_interval_hours, nudge_max_count').eq('business_id', businessId).maybeSingle();
            return data;
          },
        });
      },
    });

    const sent    = results.filter(r => r.status === 'sent').length;
    const skipped = results.filter(r => r.skipped).length;

    return res.json({ status: 'success', processed: results.length, sent, skipped, results, nudges });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: e.message });
  }
});

// ── Trial-day reminders (ניהול לידים) ─────────────────────────────────────────
// Manual-by-default now: lib/daily-scheduler.js tells the owner over Telegram
// when a business has trial signups today, and she sends from the studio's
// leads-board screen (lib/trial-reminders.js#previewTrialReminders/
// sendTrialReminders, wired through lib/studio.js). This endpoint remains as
// a manual trigger / fallback for the OLD fully-automatic pass — secured by
// a bearer secret (CRON_SECRET, constant-time compare) — but its auto-send
// only runs when TRIAL_REMINDERS_CRON_AUTOSEND=true, or the caller passes
// {"force":true} for a one-off manual run. See lib/trial-reminders.js.
app.post('/cron/trial-reminders', async (req, res) => {
  try {
    const { cronAuthOk, runTrialReminders, cronAutoSendEnabled } = await import('./lib/trial-reminders.js');
    if (!cronAuthOk(req.headers.authorization, process.env.CRON_SECRET)) {
      return res.status(401).json({ status: 'error', message: 'unauthorized' });
    }
    const forced = req.body?.force === true || req.query?.force === 'true';
    if (!cronAutoSendEnabled() && !forced) {
      return res.json({ status: 'skipped', message: 'auto-send disabled — manual mode is default. Pass {"force":true} to run anyway.' });
    }
    const result = await runTrialReminders({});
    return res.json({ status: 'success', ...result });
  } catch (e) {
    console.error('[cron] trial-reminders failed:', e.message);
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

// ── Billing summary ───────────────────────────────────────────────────────────
// Meta WA API estimated rates (USD) — update when real API connects
const WA_RATES = { user_initiated: 0.015, business_initiated: 0.055 };
const FREE_TIER_UI = 1000; // first 1000 user-initiated per month are free
const USD_TO_ILS = 3.7;

app.get('/billing/:business_id', async (req, res) => {
  const { business_id } = req.params;
  const { month } = req.query; // format: YYYY-MM, defaults to current month
  try {
    const { supabase } = await import('./lib/supabase.js');
    const targetMonth = month || new Date().toISOString().slice(0, 7);
    const monthStart = `${targetMonth}-01`;
    const monthEnd = `${targetMonth}-31`;

    const { data: events, error } = await supabase
      .from('wa_billing_events')
      .select('type, window_date')
      .eq('business_id', business_id)
      .gte('window_date', monthStart)
      .lte('window_date', monthEnd);

    if (error) return res.status(500).json({ status: 'error', message: error.message });

    const ui = events?.filter(e => e.type === 'user_initiated').length ?? 0;
    const bi = events?.filter(e => e.type === 'business_initiated').length ?? 0;
    const total = ui + bi;

    // Cost: UI free up to FREE_TIER_UI, then charged; BI always charged
    const uiChargeable = Math.max(0, ui - FREE_TIER_UI);
    const costUsd = (uiChargeable * WA_RATES.user_initiated) + (bi * WA_RATES.business_initiated);
    const costIls = Math.ceil(costUsd * USD_TO_ILS * 100) / 100;

    return res.json({
      status: 'success',
      month: targetMonth,
      total_conversations: total,
      user_initiated: ui,
      business_initiated: bi,
      free_tier_remaining: Math.max(0, FREE_TIER_UI - ui),
      estimated_cost_usd: Math.round(costUsd * 100) / 100,
      estimated_cost_ils: costIls,
    });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: e.message });
  }
});

// ── Admin: list all businesses with stats ─────────────────────────────────────
app.get('/admin/businesses', async (req, res) => {
  try {
    const { supabase } = await import('./lib/supabase.js');
    const month      = new Date().toISOString().slice(0, 7);
    const monthStart = `${month}-01`;
    const monthEnd   = `${month}-31`;
    const now        = new Date();

    const { data: businesses, error } = await supabase
      .from('businesses')
      .select('id, name, slug, archetype, status, is_test, created_at, contact_email')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ status: 'error', message: error.message });

    const enriched = await Promise.all((businesses ?? []).map(async (biz) => {
      const [profileRes, contactsRes, faqRes, billingRes, sessionRes] = await Promise.all([
        supabase.from('business_profiles').select('agent_active, persona, setup_completed').eq('business_id', biz.id).maybeSingle(),
        supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('business_id', biz.id),
        supabase.from('knowledge_items').select('id', { count: 'exact', head: true }).eq('business_id', biz.id).eq('is_active', true),
        supabase.from('wa_billing_events').select('type, window_date').eq('business_id', biz.id).gte('window_date', monthStart).lte('window_date', monthEnd),
        supabase.from('sessions').select('session_mode, setup_completed, updated_at').eq('business_id', biz.id).order('updated_at', { ascending: false }).limit(1).maybeSingle(),
      ]);

      const ui   = billingRes.data?.filter(e => e.type === 'user_initiated').length ?? 0;
      const bi   = billingRes.data?.filter(e => e.type === 'business_initiated').length ?? 0;
      const cost = Math.max(0, ui - 1000) * 0.015 + bi * 0.055;

      const sess    = sessionRes.data;
      const profile = profileRes.data;
      const hasDemo = profile?.persona?.extracted_from_demo === true;
      const daysSinceActivity = sess?.updated_at
        ? Math.floor((now - new Date(sess.updated_at)) / 86400000)
        : 999;

      // Health: red = stuck in setup >3d, yellow = cold >7d or no demo or no faq
      let health = 'green';
      if (!sess || sess.session_mode === 'setup') {
        health = daysSinceActivity > 3 ? 'red' : 'yellow';
      } else if (daysSinceActivity > 7 || !hasDemo || (faqRes.count ?? 0) === 0) {
        health = 'yellow';
      }

      return {
        ...biz,
        session_mode:     sess?.session_mode ?? null,
        setup_completed:  sess?.setup_completed ?? false,
        agent_active:     profile?.agent_active ?? true,
        has_demo:         hasDemo,
        total_leads:      contactsRes.count ?? 0,
        active_faq:       faqRes.count ?? 0,
        last_activity:    sess?.updated_at ?? null,
        days_inactive:    daysSinceActivity,
        billing_month:    { ui, bi, estimated_cost_usd: Math.round(cost * 100) / 100 },
        health,
      };
    }));

    // Global totals
    const totalUI  = enriched.reduce((s, b) => s + b.billing_month.ui, 0);
    const totalBI  = enriched.reduce((s, b) => s + b.billing_month.bi, 0);
    const totalCost = enriched.reduce((s, b) => s + b.billing_month.estimated_cost_usd, 0);

    return res.json({
      status: 'success',
      businesses: enriched,
      global: { total_businesses: enriched.length, month, ui: totalUI, bi: totalBI, estimated_cost_usd: Math.round(totalCost * 100) / 100, estimated_cost_ils: Math.ceil(totalCost * 3.7 * 100) / 100 },
    });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: e.message });
  }
});

// ── Admin: delete business (cascade) ─────────────────────────────────────────
app.delete('/admin/business/:id', async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ status: 'error', message: 'id required' });
  try {
    const { supabase } = await import('./lib/supabase.js');
    // Get all session_ids for this business first
    const { data: sessions } = await supabase.from('sessions').select('session_id').eq('business_id', id);
    const sessionIds = (sessions ?? []).map(s => s.session_id);

    await Promise.all([
      sessionIds.length && supabase.from('conversation_messages').delete().in('session_id', sessionIds),
      sessionIds.length && supabase.from('setup_drafts').delete().in('session_id', sessionIds),
      sessionIds.length && supabase.from('agent_runs').delete().in('session_id', sessionIds).catch(() => {}),
      supabase.from('contacts').delete().eq('business_id', id),
      supabase.from('knowledge_items').delete().eq('business_id', id),
      supabase.from('wa_billing_events').delete().eq('business_id', id),
      supabase.from('lead_followups').delete().eq('business_id', id),
      supabase.from('business_profiles').delete().eq('business_id', id),
    ].filter(Boolean));

    await supabase.from('sessions').delete().eq('business_id', id);
    const { error } = await supabase.from('businesses').delete().eq('id', id);
    if (error) return res.status(500).json({ status: 'error', message: error.message });
    return res.json({ status: 'success' });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: e.message });
  }
});

// ── Admin: edit business ──────────────────────────────────────────────────────
app.patch('/admin/business/:id', async (req, res) => {
  const { id } = req.params;
  const { name, status, archetype } = req.body ?? {};
  try {
    const { supabase } = await import('./lib/supabase.js');
    const updates = {};
    if (name)      updates.name = name;
    if (status)    updates.status = status;
    if (archetype) updates.archetype = archetype;
    const { error } = await supabase.from('businesses').update(updates).eq('id', id);
    if (error) return res.status(500).json({ status: 'error', message: error.message });
    return res.json({ status: 'success' });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
// A missed booster env key degrades the express funnel without failing
// anything, so make the deploy gap visible at boot rather than leaving it to
// be inferred from a caught insert error weeks later (plan T17).
warnOnIncompleteBoosterEnv();

// Owner-in-the-loop trial-day Telegram notice (see lib/daily-scheduler.js) —
// in-process, no external cron. Lazy import so a broken module degrades
// (logged) rather than failing boot, same convention as loadAgents() below.
import('./lib/daily-scheduler.js').then(m => m.startDailyScheduler())
  .catch(e => console.error('[daily-scheduler] failed to start:', e.message));

const PORT = process.env.PORT ?? 8080;
loadAgents().then(() => {
  app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
});

function stub(mode) {
  return { status: 'success', result: { response: `[${mode} agent not yet implemented]`, next_stage: 'stub' } };
}
