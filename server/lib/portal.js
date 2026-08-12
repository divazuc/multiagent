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
// Clients may edit operational settings (mode, hours, follow-up). The bot
// POLICY (guardrails: escalation points / forbidden topics) stays admin-only
// so conversation flow can't change without the operator knowing.
const CONTACT_COLUMNS = ['name', 'notes', 'status'];
const FAQ_COLUMNS = ['category', 'question', 'answer', 'is_active', 'suggested'];

// Evaluation accounts opt out of the policy lock. Read fresh on every write —
// revoking access must take effect immediately, not at the next login.
async function isFullEdit(bizId) {
  const { data } = await supabase
    .from('businesses').select('portal_full_edit').eq('id', bizId).maybeSingle();
  return data?.portal_full_edit === true;
}

const ops = {
  async getBusiness(bizId) {
    const { data, error } = await supabase
      .from('businesses')
      .select('id, name, business_category, whatsapp_number, portal_full_edit')
      .eq('id', bizId).maybeSingle();
    if (error) throw error;
    return data;
  },

  getOverviewStats: (bizId, days, domain) => runStudioOp('getOverviewStats', [bizId, days, domain]),
  loadFaqItems:     (bizId) => runStudioOp('loadFaqItems', [bizId]),
  getBotSettings:   (bizId) => runStudioOp('getBotSettings', [bizId]),
  updateBotIdentity: (bizId, botId, patch) => runStudioOp('updateBotIdentity', [bizId, botId, patch ?? {}]),
  addFaqItem:       (bizId, fields) => runStudioOp('addFaqItem', [bizId, fields ?? {}]),
  getInterviewQuestions:      (bizId) => runStudioOp('getInterviewQuestions', [bizId]),
  answerInterviewQuestion:    (bizId, id, raw) => runStudioOp('answerInterviewQuestion', [bizId, id, raw]),
  dismissInterviewQuestion:   (bizId, id) => runStudioOp('dismissInterviewQuestion', [bizId, id]),
  generateInterviewQuestions: (bizId, bot) => runStudioOp('generateInterviewQuestions', [bizId, bot ?? null]),

  // Read-only: the client may see who the bot escalates to, never change it.
  // Redirecting escalations to a different number stays an operator action —
  // see server/lib/studio.js#setBusinessContact, deliberately NOT exposed here.
  // Projected down to {name, phone, email}: `notes` is an internal operator
  // note about the contact (e.g. "sales manager, mornings only") and must
  // never reach the client's browser, even though the studio op returns it.
  async getBusinessContacts(bizId) {
    const { owner, rep } = await runStudioOp('getBusinessContacts', [bizId]);
    const pub = (c) => c ? { name: c.name ?? null, phone: c.phone ?? null, email: c.email ?? null } : null;
    return { owner: pub(owner), rep: pub(rep) };
  },

  async updateFaqItem(bizId, id, updates) {
    await assertOwned('knowledge_items', id, bizId);
    const clean = {};
    for (const k of FAQ_COLUMNS) if (k in (updates ?? {})) clean[k] = updates[k];
    return runStudioOp('updateFaqItem', [id, clean]);
  },

  async deleteFaqItem(bizId, id) {
    await assertOwned('knowledge_items', id, bizId);
    return runStudioOp('deleteFaqItem', [id]);
  },

  async updateBotSettings(bizId, updates) {
    const { settingsColumnsFor, pickSettings } = await import('./portal-permissions.js');
    const clean = pickSettings(updates, settingsColumnsFor(await isFullEdit(bizId)));
    if (!Object.keys(clean).length) return;
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

  // ── Leads board (ניהול לידים — the `leads` module, lib/leads.js) ──────────
  // listLeads carries its own `enabled` flag so the portal can hide the tab
  // for businesses without the module; updateLead 404s on a lead id outside
  // the token's business (the lookup itself is business-scoped). CSV export
  // is the separate GET /portal/leads.csv (index.js) — same token, but a file
  // download rather than an RPC result.
  async listLeads(bizId, filters) {
    const { listLeadsForApi } = await import('./leads.js');
    return listLeadsForApi(bizId, filters ?? {});
  },

  async updateLead(bizId, id, updates) {
    const { applyLeadUpdate } = await import('./leads.js');
    return applyLeadUpdate(bizId, id, updates ?? {}, 'owner');
  },

  // Manual "סנכרון מהגיליון" — pull the registration sheet now instead of
  // waiting for the morning cron. THROWS (surfaced as a toast) when no sheet
  // is configured; the button only renders when listLeads says one is.
  async syncLeadsSheet(bizId) {
    const { syncSheetLeads } = await import('./leads-sheet.js');
    return syncSheetLeads(bizId);
  },

  // The board's in-app conversation view (phone click). Doubly scoped inside
  // getLeadConversation: the phone must be a lead of THIS business (else 404)
  // and the message query itself filters by business_id.
  async getLeadConversation(bizId, phone) {
    const { getLeadConversation } = await import('./leads.js');
    return getLeadConversation(bizId, phone);
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
