import express from 'express';
import { supabase } from '../lib/supabase.js';

const router = express.Router();

// ── Businesses ────────────────────────────────────────────────────────────────

router.get('/businesses', async (_req, res) => {
  const { data, error } = await supabase
    .from('businesses')
    .select('id, name, slug, archetype, plan_type, status, is_test, whatsapp_number, setup_completed, setup_stage, created_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

router.post('/businesses', async (req, res) => {
  const { name, slug, archetype, planType = 'basic', phone, isTest = false } = req.body;
  const whatsappNumber = phone || (isTest ? `test_${Math.random().toString(36).slice(2, 10).toUpperCase()}` : null);
  const { data, error } = await supabase
    .from('businesses')
    .insert({ name, slug: slug || null, archetype: archetype || null, plan_type: planType, whatsapp_number: whatsappNumber, status: 'active', is_test: isTest })
    .select().maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.patch('/businesses/:id', async (req, res) => {
  const allowed = ['whatsapp_number', 'status', 'name', 'archetype', 'plan_type'];
  const updates = Object.fromEntries(allowed.filter(k => req.body[k] !== undefined).map(k => [k, req.body[k]]));
  updates.updated_at = new Date().toISOString();
  const { error } = await supabase.from('businesses').update(updates).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Sessions ──────────────────────────────────────────────────────────────────

router.get('/sessions', async (_req, res) => {
  const { data, error } = await supabase
    .from('sessions')
    .select('session_id, session_mode, current_stage, current_setup_stage, setup_completed, business_id, created_at, updated_at')
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

router.post('/sessions', async (req, res) => {
  const { sessionId, mode, businessId = null } = req.body;
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
    .select().maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.patch('/sessions/:id', async (req, res) => {
  const allowed = ['session_mode', 'current_stage', 'current_setup_stage', 'setup_completed', 'business_id'];
  const updates = Object.fromEntries(allowed.filter(k => req.body[k] !== undefined).map(k => [k, req.body[k]]));
  updates.updated_at = new Date().toISOString();
  const { error } = await supabase.from('sessions').update(updates).eq('session_id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.delete('/sessions/:id', async (req, res) => {
  await Promise.all([
    supabase.from('conversation_messages').delete().eq('session_id', req.params.id),
    supabase.from('setup_drafts').delete().eq('session_id', req.params.id),
  ]);
  await supabase.from('sessions').delete().eq('session_id', req.params.id);
  res.json({ ok: true });
});

router.get('/sessions/:id/state', async (req, res) => {
  const sid = req.params.id;
  const [sessionRes, draftRes, messagesRes] = await Promise.all([
    supabase.from('sessions').select('*').eq('session_id', sid).maybeSingle(),
    supabase.from('setup_drafts').select('*').eq('session_id', sid).maybeSingle(),
    supabase.from('conversation_messages').select('*').eq('session_id', sid).order('created_at', { ascending: true }).limit(50),
  ]);
  let profile = null;
  if (sessionRes.data?.business_id) {
    const { data } = await supabase.from('business_profiles').select('*').eq('business_id', sessionRes.data.business_id).maybeSingle();
    profile = data;
  }
  res.json({ session: sessionRes.data ?? null, draft: draftRes.data ?? null, profile, messages: messagesRes.data ?? [] });
});

router.post('/sessions/:id/seed-profile', async (req, res) => {
  const businessId = `seed-${req.params.id}`;
  await supabase.from('business_profiles').upsert(
    { business_id: businessId, session_id: req.params.id, ...req.body, setup_completed: true, setup_stage: 'completed', draft_setup_data: {} },
    { onConflict: 'business_id' }
  );
  await supabase.from('sessions').update({
    business_id: businessId, session_mode: 'live', setup_completed: true,
    current_stage: 'start', updated_at: new Date().toISOString()
  }).eq('session_id', req.params.id);
  res.json({ ok: true });
});

// ── Knowledge (FAQ) ───────────────────────────────────────────────────────────

router.get('/knowledge/:businessId', async (req, res) => {
  const { data, error } = await supabase
    .from('knowledge_items')
    .select('id, category, question, answer, archetypes, is_active, suggested, created_at')
    .eq('business_id', req.params.businessId)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

router.get('/knowledge/:businessId/suggested-count', async (req, res) => {
  const { count, error } = await supabase
    .from('knowledge_items')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', req.params.businessId)
    .eq('suggested', true)
    .eq('is_active', false);
  if (error) return res.json({ count: 0 });
  res.json({ count: count ?? 0 });
});

router.post('/knowledge/:businessId', async (req, res) => {
  const { category, question, answer = '', archetypes = [] } = req.body;
  const { data, error } = await supabase
    .from('knowledge_items')
    .insert({ business_id: req.params.businessId, category: category || 'general', question, answer, archetypes: Array.isArray(archetypes) ? archetypes : [], language: 'he', is_active: false })
    .select().maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/knowledge/:businessId/seed', async (req, res) => {
  const { starters = [] } = req.body;
  const { count } = await supabase.from('knowledge_items').select('id', { count: 'exact', head: true }).eq('business_id', req.params.businessId);
  if (count > 0) return res.json({ ok: true, seeded: false });
  if (!starters.length) return res.json({ ok: true, seeded: false });
  const rows = starters.map(item => ({
    business_id: req.params.businessId, category: item.category, question: item.question,
    answer: '', archetypes: item.archetypes || [], language: 'he', is_active: false,
  }));
  const { error } = await supabase.from('knowledge_items').insert(rows);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, seeded: true });
});

router.patch('/knowledge/:id/approve', async (req, res) => {
  const { error } = await supabase.from('knowledge_items')
    .update({ is_active: true, suggested: false, updated_at: new Date().toISOString() })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.patch('/knowledge/:id', async (req, res) => {
  const { error } = await supabase.from('knowledge_items')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.delete('/knowledge/:id', async (req, res) => {
  const { error } = await supabase.from('knowledge_items').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Agent Runs ────────────────────────────────────────────────────────────────

router.get('/runs', async (req, res) => {
  let q = supabase
    .from('agent_runs')
    .select('id, session_id, business_id, status, session_mode, total_duration_ms, final_response, error, created_at, completed_at')
    .order('created_at', { ascending: false })
    .limit(50);
  if (req.query.session_id) q = q.eq('session_id', req.query.session_id);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

router.get('/runs/:id', async (req, res) => {
  const { data, error } = await supabase.from('agent_runs').select('id, steps').eq('id', req.params.id).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

export default router;
