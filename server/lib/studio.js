import { supabase } from './supabase.js';

// Named-operation whitelist for the wa-studio frontend. Each op mirrors a
// query the studio previously ran directly against Supabase with the anon
// key — moved server-side after anon grants were revoked (RLS audit).

const FAQ_UPDATE_COLUMNS = ['category', 'question', 'answer', 'archetypes', 'is_active', 'suggested'];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (k in (obj ?? {})) out[k] = obj[k];
  return out;
}

const ops = {
  // ── Businesses ─────────────────────────────────────────────────────────────
  async listBusinesses() {
    const { data, error } = await supabase
      .from('businesses')
      .select('id, name, slug, archetype, plan_type, status, is_test, whatsapp_number, setup_completed, setup_stage, created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data ?? [];
  },

  async createBusiness({ name, slug, archetype, planType = 'basic', phone, isTest = false } = {}) {
    if (!name) { const e = new Error('name is required'); e.status = 400; throw e; }
    const whatsappNumber = phone || (isTest ? `test_${Math.random().toString(36).slice(2, 10).toUpperCase()}` : null);
    const { data, error } = await supabase
      .from('businesses')
      .insert({
        name,
        slug: slug || null,
        archetype: archetype || null,
        plan_type: planType,
        whatsapp_number: whatsappNumber,
        status: 'active',
        is_test: isTest,
      })
      .select()
      .maybeSingle();
    if (error) throw error;
    return data;
  },

  async updateBusinessPhone(businessId, phone) {
    const { error } = await supabase
      .from('businesses')
      .update({ whatsapp_number: phone, updated_at: new Date().toISOString() })
      .eq('id', businessId);
    if (error) throw error;
  },

  async setBusinessStatus(businessId, status) {
    const { error } = await supabase
      .from('businesses')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', businessId);
    if (error) throw error;
  },

  // ── Sessions ───────────────────────────────────────────────────────────────
  async createSession(sessionId, mode, businessId = null) {
    const { data, error } = await supabase
      .from('sessions')
      .upsert({
        session_id: sessionId,
        session_mode: mode,
        business_id: businessId,
        setup_completed: mode !== 'setup',
        current_stage: mode === 'setup' ? 'business_details' : 'start',
        current_setup_stage: mode === 'setup' ? 'business_details' : null,
      }, { onConflict: 'session_id' })
      .select()
      .maybeSingle();
    if (error) throw error;
    return data;
  },

  async listSessions() {
    const { data, error } = await supabase
      .from('sessions')
      .select('session_id, session_mode, current_stage, current_setup_stage, setup_completed, business_id, created_at, updated_at')
      .order('created_at', { ascending: false })
      .limit(30);
    if (error) throw error;
    return data ?? [];
  },

  async loadDBState(sessionId) {
    const [sessionRes, draftRes, messagesRes] = await Promise.all([
      supabase.from('sessions').select('*').eq('session_id', sessionId).maybeSingle(),
      supabase.from('setup_drafts').select('*').eq('session_id', sessionId).maybeSingle(),
      supabase.from('conversation_messages')
        .select('*').eq('session_id', sessionId)
        .order('created_at', { ascending: true }).limit(50),
    ]);
    let profile = null;
    if (sessionRes.data?.business_id) {
      const { data } = await supabase
        .from('business_profiles').select('*')
        .eq('business_id', sessionRes.data.business_id).maybeSingle();
      profile = data ?? null;
    }
    return {
      session: sessionRes.data ?? null,
      draft: draftRes.data ?? null,
      profile,
      messages: messagesRes.data ?? [],
    };
  },

  async clearSessionData(sessionId) {
    await Promise.all([
      supabase.from('conversation_messages').delete().eq('session_id', sessionId),
      supabase.from('setup_drafts').delete().eq('session_id', sessionId),
    ]);
    await supabase.from('sessions').delete().eq('session_id', sessionId);
  },

  async advanceSetupStage(sessionId, nextStage, setupCompleted = false) {
    const update = { current_stage: nextStage, current_setup_stage: nextStage, updated_at: new Date().toISOString() };
    if (setupCompleted) update.setup_completed = true;
    const { error } = await supabase.from('sessions').update(update).eq('session_id', sessionId);
    if (error) throw error;
  },

  async markSetupComplete(sessionId) {
    const { error } = await supabase
      .from('sessions')
      .update({ setup_completed: true, updated_at: new Date().toISOString() })
      .eq('session_id', sessionId);
    if (error) throw error;
  },

  async setSessionMode(sessionId, mode) {
    const { error } = await supabase
      .from('sessions')
      .update({ session_mode: mode, updated_at: new Date().toISOString() })
      .eq('session_id', sessionId);
    if (error) throw error;
  },

  // ── FAQ / knowledge items ──────────────────────────────────────────────────
  async loadFaqItems(businessId) {
    const { data, error } = await supabase
      .from('knowledge_items')
      .select('id, category, question, answer, archetypes, is_active, suggested, created_at')
      .eq('business_id', businessId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data ?? [];
  },

  async loadSuggestedFaqCount(businessId) {
    const { count, error } = await supabase
      .from('knowledge_items')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', businessId)
      .eq('suggested', true)
      .eq('is_active', false);
    if (error) return 0;
    return count ?? 0;
  },

  async approveSuggestedFaqItem(id) {
    const { error } = await supabase
      .from('knowledge_items')
      .update({ is_active: true, suggested: false, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  },

  async dismissSuggestedFaqItem(id) {
    const { error } = await supabase.from('knowledge_items').delete().eq('id', id);
    if (error) throw error;
  },

  async updateFaqItem(id, updates) {
    const clean = pick(updates, FAQ_UPDATE_COLUMNS);
    const { error } = await supabase
      .from('knowledge_items')
      .update({ ...clean, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  },

  async deleteFaqItem(id) {
    const { error } = await supabase.from('knowledge_items').delete().eq('id', id);
    if (error) throw error;
  },

  async addFaqItem(businessId, { category, question, answer = '', archetypes = [] } = {}) {
    const { data, error } = await supabase
      .from('knowledge_items')
      .insert({
        business_id: businessId,
        category: category || 'general',
        question,
        answer,
        archetypes: Array.isArray(archetypes) ? archetypes : [],
        language: 'he',
        is_active: false,
      })
      .select().maybeSingle();
    if (error) throw error;
    return data;
  },

  // Frontend computes starter rows (archetype filtering lives in wa-studio);
  // the server only guards against double-seeding and stray fields.
  async seedFaqItems(businessId, rows) {
    const { count, error: countError } = await supabase
      .from('knowledge_items')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', businessId);
    if (countError) throw countError;
    if (count > 0 || !Array.isArray(rows) || !rows.length) return;

    const clean = rows.slice(0, 50).map(r => ({
      business_id: businessId,
      category: r.category || 'general',
      question: r.question,
      answer: '',
      archetypes: Array.isArray(r.archetypes) ? r.archetypes : [],
      language: 'he',
      is_active: false,
    }));
    const { error } = await supabase.from('knowledge_items').insert(clean);
    if (error) throw error;
  },

  // ── Presets ────────────────────────────────────────────────────────────────
  async seedBusinessProfile(sessionId, profile) {
    const businessId = `seed-${sessionId}`;
    await supabase.from('business_profiles').upsert({
      business_id: businessId,
      session_id: sessionId,
      ...profile,
      setup_completed: true,
      setup_stage: 'completed',
      draft_setup_data: {},
    }, { onConflict: 'business_id' });
    await supabase.from('sessions').update({
      business_id: businessId,
      session_mode: 'live',
      setup_completed: true,
      current_stage: 'start',
      updated_at: new Date().toISOString(),
    }).eq('session_id', sessionId);
  },

  // ── Agent runs (RunsPanel) ─────────────────────────────────────────────────
  async listRuns(sessionId = null) {
    let q = supabase
      .from('agent_runs')
      .select('id, session_id, business_id, status, session_mode, total_duration_ms, final_response, error, created_at, completed_at')
      .order('created_at', { ascending: false })
      .limit(50);
    if (sessionId) q = q.eq('session_id', sessionId);
    const { data, error } = await q;
    if (error) throw error;
    return data ?? [];
  },

  async getRunSteps(runId) {
    const { data, error } = await supabase
      .from('agent_runs')
      .select('id, steps')
      .eq('id', runId)
      .single();
    if (error) throw error;
    return data?.steps ?? [];
  },

  // ── Portal account provisioning (operator-side) ────────────────────────────
  async createPortalAccount(businessId, email, password) {
    if (!businessId || !email || !password) { const e = new Error('businessId, email, password required'); e.status = 400; throw e; }
    const { hashPassword } = await import('./portal.js');
    const { data, error } = await supabase
      .from('portal_accounts')
      .upsert({
        business_id: businessId,
        email: String(email).trim().toLowerCase(),
        password_hash: hashPassword(password),
      }, { onConflict: 'email' })
      .select('id, business_id, email')
      .maybeSingle();
    if (error) throw error;
    return data;
  },

  // ── Bot settings (client dashboard) ────────────────────────────────────────
  async getBotSettings(businessId) {
    if (!businessId) { const e = new Error('businessId is required'); e.status = 400; throw e; }
    const { data, error } = await supabase
      .from('business_profiles')
      .select('agent_active, answer_after_hours, working_hours, after_hours_message, followup_enabled, followup_delay_days, followup_message, guardrails, persona')
      .eq('business_id', businessId)
      .maybeSingle();
    if (error) throw error;
    return data ?? {};
  },

  async deleteFaqItem(id) {
    if (!id) { const e = new Error('id is required'); e.status = 400; throw e; }
    const { error } = await supabase.from('knowledge_items').delete().eq('id', id);
    if (error) throw error;
  },

  // ── Business overview (client dashboard) ───────────────────────────────────
  async getOverviewStats(businessId, days = 30) {
    if (!businessId) { const e = new Error('businessId is required'); e.status = 400; throw e; }
    days = Math.min(Math.max(Number(days) || 30, 7), 120);
    const since = new Date(Date.now() - days * 86400000);
    const sinceIso = since.toISOString();

    const [profileRes, contactsRes, runsRes] = await Promise.all([
      supabase.from('business_profiles')
        .select('working_hours, draft_setup_data')
        .eq('business_id', businessId).maybeSingle(),
      supabase.from('contacts')
        .select('id, created_at', { count: 'exact' })
        .eq('business_id', businessId),
      supabase.from('agent_runs')
        .select('total_duration_ms')
        .eq('business_id', businessId)
        .eq('status', 'success')
        .eq('session_mode', 'live')
        .not('total_duration_ms', 'is', null)
        .order('created_at', { ascending: false })
        .limit(200),
    ]);

    // PostgREST caps a response at 1000 rows — page through the range.
    const messages = [];
    for (let page = 0; page < 12; page++) {
      const { data, error } = await supabase.from('conversation_messages')
        .select('session_id, created_at, escalate, cta_triggered, user_message')
        .eq('business_id', businessId)
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: true })
        .range(page * 1000, page * 1000 + 999);
      if (error) throw error;
      messages.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }

    const profile = profileRes.data ?? {};
    const wh = profile.working_hours ?? null;

    // Hebrew keyword buckets mirroring the three business domains. Doctors
    // first: "קורס הזרקות" must not fall into treatments via "הזרק".
    const DOMAIN_TESTS = [
      ['doctors', /קורס|רופא|הכשר|סילבוס|השתלמ|בי.?ה.?ס/],
      ['hair', /שיער|גבות|זקן|השתל|קרקפת|נשיר|FUE/i],
    ];

    const jerusalem = (iso) => new Date(new Date(iso).toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const isAfterHours = (iso) => {
      const d = jerusalem(iso);
      const day = wh?.days?.[d.getDay()];
      if (!day) return d.getDay() === 6 || d.getHours() < 9 || d.getHours() >= 19;
      if (!day.active) return true;
      const cur = d.getHours() * 60 + d.getMinutes();
      const [fH, fM] = (day.from || '09:00').split(':').map(Number);
      const [tH, tM] = (day.to || '18:00').split(':').map(Number);
      return cur < fH * 60 + fM || cur > tH * 60 + tM;
    };

    const localDateKey = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

    const daily = new Map();
    for (let i = days - 1; i >= 0; i--) {
      const key = localDateKey(new Date(Date.now() - i * 86400000));
      daily.set(key, { date: key, messages: 0, after_hours: 0, sessions: new Set() });
    }

    const sessions = new Map(); // session_id -> {text, escalated, cta, after_hours_first}
    let afterHoursMessages = 0;

    for (const m of messages) {
      const bucket = daily.get(localDateKey(new Date(m.created_at)));
      const ah = isAfterHours(m.created_at);
      if (ah) afterHoursMessages++;
      if (bucket) {
        bucket.messages++;
        if (ah) bucket.after_hours++;
        bucket.sessions.add(m.session_id);
      }
      let s = sessions.get(m.session_id);
      if (!s) { s = { text: '', escalated: false, cta: false, after_hours_first: ah }; sessions.set(m.session_id, s); }
      s.text += ' ' + (m.user_message || '');
      if (m.escalate) s.escalated = true;
      if (m.cta_triggered) s.cta = true;
    }

    const domains = { treatments: 0, hair: 0, doctors: 0 };
    let escalated = 0, cta = 0, afterHoursSessions = 0;
    for (const s of sessions.values()) {
      const hit = DOMAIN_TESTS.find(([, re]) => re.test(s.text));
      domains[hit ? hit[0] : 'treatments']++;
      if (s.escalated) escalated++;
      if (s.cta) cta++;
      if (s.after_hours_first) afterHoursSessions++;
    }

    const runs = runsRes.data ?? [];
    const avgReplyMs = runs.length
      ? Math.round(runs.reduce((sum, r) => sum + r.total_duration_ms, 0) / runs.length)
      : null;

    const contactsNew = (contactsRes.data ?? []).filter(c => c.created_at >= sinceIso).length;

    const config = {
      minutes_per_reply: 3.5,
      hourly_cost_ils: 60,
      monthly_cost_ils: 2000,
      ...(profile.draft_setup_data?.dashboard_config ?? {}),
    };

    return {
      days,
      since: sinceIso,
      daily: [...daily.values()].map(d => ({ date: d.date, messages: d.messages, after_hours: d.after_hours, conversations: d.sessions.size })),
      totals: {
        conversations: sessions.size,
        messages: messages.length,
        after_hours_messages: afterHoursMessages,
        after_hours_sessions: afterHoursSessions,
        escalations: escalated,
        cta_sessions: cta,
        contacts_new: contactsNew,
        contacts_total: contactsRes.count ?? 0,
      },
      domains,
      avg_reply_ms: avgReplyMs,
      config,
    };
  },

  // ── Modules ────────────────────────────────────────────────────────────────
  async getModules(businessId) {
    const { MODULES } = await import('./modules/registry.js');
    const { data, error } = await supabase.from('business_modules')
      .select('module_key, enabled, settings, status, status_detail, updated_at')
      .eq('business_id', businessId);
    if (error) throw error;
    const rows = data ?? [];
    return Object.values(MODULES).map(def => {
      const row = rows.find(r => r.module_key === def.key);
      return {
        key: def.key, name: def.name, adminUI: def.adminUI,
        enabled: row?.enabled ?? false,
        settings: { ...def.defaultSettings, ...(row?.settings ?? {}) },
        status: row?.status ?? 'disconnected', status_detail: row?.status_detail ?? null,
      };
    });
  },

  async updateModule(businessId, moduleKey, { enabled, settings } = {}) {
    const { MODULES } = await import('./modules/registry.js');
    const def = MODULES[moduleKey];
    if (!def) { const e = new Error('unknown module'); e.status = 400; throw e; }
    const parsed = def.settingsSchema.safeParse(settings ?? {});
    if (!parsed.success) {
      const e = new Error('invalid settings: ' + parsed.error.issues.map(i => i.path.join('.') + ' ' + i.message).join('; '));
      e.status = 400; throw e;
    }
    const { error } = await supabase.from('business_modules').upsert({
      business_id: businessId, module_key: moduleKey,
      enabled: !!enabled, settings: parsed.data, updated_at: new Date().toISOString(),
    }, { onConflict: 'business_id,module_key' });
    if (error) throw error;
    const { logModuleEvent } = await import('./modules/engine.js');
    logModuleEvent(businessId, moduleKey, enabled ? 'enabled' : 'disabled', null);
  },

  async createConnectLink(businessId, moduleKey) {
    const { signConnectState } = await import('../routes/oauth.js');
    const base = process.env.PUBLIC_BASE_URL ?? 'https://wagent.divdev.co';
    return { url: `${base}/oauth/google/start?state=${signConnectState(businessId, moduleKey)}` };
  },
};

export async function runStudioOp(fn, args) {
  const handler = ops[fn];
  if (!handler) {
    const err = new Error(`unknown studio op: ${fn}`);
    err.status = 400;
    throw err;
  }
  return handler(...(Array.isArray(args) ? args : []));
}
