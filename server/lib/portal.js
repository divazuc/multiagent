// Client portal: per-business authentication + a business-scoped op whitelist.
// The trust model: the signed token carries business_id; ops NEVER accept a
// business id from the client, and row-level ops verify ownership first.

import crypto from 'node:crypto';
import { supabase } from './supabase.js';
import { runStudioOp } from './studio.js';

const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

function secret() {
  const s = process.env.PORTAL_TOKEN_SECRET;
  if (!s) throw new Error('PORTAL_TOKEN_SECRET is not configured');
  return s;
}

// ── Passwords (scrypt, no external deps) ─────────────────────────────────────
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored ?? '').split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
  } catch { return false; }
}

// ── Tokens (HMAC-signed payload, stateless) ──────────────────────────────────
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token) {
  const [body, sig] = String(token ?? '').split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch { return null; }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.business_id || !payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

// ── Login ────────────────────────────────────────────────────────────────────
export async function portalLogin(email, password) {
  const err = () => { const e = new Error('אימייל או סיסמה שגויים'); e.status = 401; return e; };
  if (!email || !password) throw err();

  const { data: account } = await supabase
    .from('portal_accounts')
    .select('id, business_id, password_hash')
    .eq('email', String(email).trim().toLowerCase())
    .maybeSingle();
  if (!account || !verifyPassword(password, account.password_hash)) throw err();

  const { data: biz } = await supabase
    .from('businesses')
    .select('id, name, status')
    .eq('id', account.business_id)
    .maybeSingle();
  if (!biz || biz.status !== 'active') throw err();

  supabase.from('portal_accounts')
    .update({ last_login_at: new Date().toISOString() })
    .eq('id', account.id)
    .then(() => {}, () => {});

  const token = signToken({ business_id: biz.id, account_id: account.id, exp: Date.now() + TOKEN_TTL_MS });
  return { token, business: { id: biz.id, name: biz.name } };
}

// ── Ownership guard for row-level ops ────────────────────────────────────────
async function assertOwned(table, id, businessId) {
  const { data } = await supabase.from(table).select('id').eq('id', id).eq('business_id', businessId).maybeSingle();
  if (!data) { const e = new Error('not found'); e.status = 404; throw e; }
}

// ── Business-scoped ops (business_id always injected from the token) ─────────
const SETTINGS_COLUMNS = ['working_hours', 'agent_active', 'answer_after_hours', 'after_hours_message'];
const CONTACT_COLUMNS = ['name', 'notes', 'status'];
const FAQ_COLUMNS = ['category', 'question', 'answer', 'is_active', 'suggested'];

const ops = {
  async getBusiness(bizId) {
    const { data, error } = await supabase
      .from('businesses')
      .select('id, name, business_category, whatsapp_number')
      .eq('id', bizId).maybeSingle();
    if (error) throw error;
    return data;
  },

  getOverviewStats: (bizId, days) => runStudioOp('getOverviewStats', [bizId, days]),
  loadFaqItems:     (bizId) => runStudioOp('loadFaqItems', [bizId]),
  getBotSettings:   (bizId) => runStudioOp('getBotSettings', [bizId]),
  addFaqItem:       (bizId, fields) => runStudioOp('addFaqItem', [bizId, fields ?? {}]),

  async updateFaqItem(bizId, id, updates) {
    await assertOwned('knowledge_items', id, bizId);
    const clean = {};
    for (const k of FAQ_COLUMNS) if (k in (updates ?? {})) clean[k] = updates[k];
    return runStudioOp('updateFaqItem', [id, clean]);
  },

  async updateBotSettings(bizId, updates) {
    const clean = {};
    for (const k of SETTINGS_COLUMNS) if (k in (updates ?? {})) clean[k] = updates[k];
    const { error } = await supabase
      .from('business_profiles')
      .update({ ...clean, updated_at: new Date().toISOString() })
      .eq('business_id', bizId);
    if (error) throw error;
  },

  async listContacts(bizId) {
    const { data, error } = await supabase
      .from('contacts')
      .select('id, phone, name, status, notes, ai_summary, message_count, last_activity_at, created_at')
      .eq('business_id', bizId)
      .order('last_activity_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    return data ?? [];
  },

  async updateContact(bizId, id, updates) {
    await assertOwned('contacts', id, bizId);
    const clean = {};
    for (const k of CONTACT_COLUMNS) if (k in (updates ?? {})) clean[k] = updates[k];
    const { error } = await supabase
      .from('contacts')
      .update({ ...clean, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  },

  // Conversation thread for a lead — live sessions are keyed by phone, but we
  // filter by business_id so a token can only read its own conversations.
  async loadThread(bizId, phone) {
    const [msgs, session] = await Promise.all([
      supabase.from('conversation_messages')
        .select('user_message, agent_response, created_at')
        .eq('session_id', phone)
        .eq('business_id', bizId)
        .order('created_at', { ascending: true })
        .limit(100),
      supabase.from('sessions')
        .select('qualification_progress')
        .eq('session_id', phone)
        .eq('business_id', bizId)
        .maybeSingle(),
    ]);
    if (msgs.error) throw msgs.error;
    return { messages: msgs.data ?? [], session: session.data ?? null };
  },
};

export async function runPortalOp(businessId, fn, args) {
  const handler = ops[fn];
  if (!handler) { const e = new Error(`unknown portal op: ${fn}`); e.status = 400; throw e; }
  return handler(businessId, ...(Array.isArray(args) ? args : []));
}
