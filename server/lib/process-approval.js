// Owner approval for BOOSTER PROCESSES — the generalization of the meeting
// approval (lib/meeting-approval.js) Diva asked for: "אפשר להוסיף אפשרות לאשר
// תהליכים בטלגרם... גם אם הבוסטר לא פתוח".
//
// Flow: the booster's outbox pushes an owner_approval_request event →
// routes/booster-webhook.js calls requestProcessApproval → an approval record
// in module_events (event_type process_approval; the token stored ONLY as a
// SHA-256 hash, exactly like meeting approvals) + a Telegram message with a
// one-time /approve/<token> link → the public routes in
// routes/process-approval.js call the booster's execute endpoint and consume
// the record on success.
//
// Unlike a meeting approval (a notification on top of a booking that already
// succeeded), here the Telegram message IS the delivery: a transient send
// failure returns 'failed' so the webhook can 502 and the booster's outbox
// retries; only PERMANENT conditions (missing Telegram env / business id)
// degrade to logging, because the booster's own server-side Telegram alert
// still exists as the old path.
import { hashToken, mintToken, TOKEN_RE, telegramConfigured, publicBaseUrl, sendTelegramText } from './approvals.js';
import { normalizeIlPhone, boosterLeadPanelUrl } from './booster-client.js';

// Forward-compat: the booster may grow kinds this deploy doesn't know — the
// webhook acks those without a record rather than retrying forever.
export const PROCESS_APPROVAL_KINDS = new Set(['payment_verify', 'work_confirm']);

// A process approval has no natural deadline like a meeting slot — 7 days is
// the expiry, measured from created_at.
export const PROCESS_APPROVAL_TTL_MS = 7 * 24 * 3600 * 1000;

// module_events store seam — same convention as lib/meeting-approval.js: the
// fake is { events: [] }; production reads/writes the real table.
let db = null;
export function _setDbForTest(fake) { db = fake; }

async function realDb() {
  const { supabase } = await import('./supabase.js');
  return {
    async insertEvent(row) {
      const { error } = await supabase.from('module_events').insert(row);
      if (error) throw error;
    },
    async findByTokenHash(hash) {
      const { data, error } = await supabase.from('module_events').select('*')
        .eq('event_type', 'process_approval')
        .eq('detail->>token_hash', hash)
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .limit(1);
      if (error) throw error;
      return data?.[0] ?? null;
    },
    async updateDetail(id, detail) {
      const { error } = await supabase.from('module_events').update({ detail }).eq('id', id);
      if (error) throw error;
    },
  };
}

// Returns the RAW token (for the Telegram link) — only its hash is stored.
export async function createProcessApproval({ businessId, kind, leadId, quoteNumber, clientName, phone, amount, context }) {
  // module_events.business_id is NOT NULL — same hard precondition as the
  // meeting approvals.
  if (!businessId) {
    console.error('[process-approval] not creating an approval — no business id');
    return null;
  }
  const token = mintToken();
  const row = {
    business_id: businessId, module_key: 'booster', event_type: 'process_approval',
    created_at: new Date().toISOString(),
    detail: {
      token_hash: hashToken(token), status: 'pending', kind,
      lead_id: leadId, quote_number: quoteNumber ?? null, client_name: clientName ?? null,
      phone: normalizeIlPhone(phone) ?? phone ?? null,
      amount: amount ?? null, context: context ?? null,
    },
  };
  if (db) { db.events.push(row); return token; }
  await (await realDb()).insertEvent(row);
  return token;
}

export async function findProcessApprovalByToken(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const hash = hashToken(token);
  if (db) {
    const rows = db.events.filter(r => r.event_type === 'process_approval' && r.detail?.token_hash === hash);
    return rows.length ? rows[rows.length - 1] : null;
  }
  return (await realDb()).findByTokenHash(hash);
}

// An unreadable created_at counts as expired — a token whose age cannot be
// established must not stay live forever.
export function approvalExpired(row, now = Date.now()) {
  const created = Date.parse(row?.created_at ?? '');
  return !Number.isFinite(created) || created + PROCESS_APPROVAL_TTL_MS <= now;
}

// Called ONLY after the booster confirmed the execute — a failed execute must
// leave the token usable for a retry (routes/process-approval.js).
export async function consumeProcessApproval(row, status = 'approved') {
  const detail = { ...row.detail, status, consumed_at: new Date().toISOString() };
  if (db) { row.detail = detail; return; }
  await (await realDb()).updateDetail(row.id, detail);
}

// ── The Telegram message ─────────────────────────────────────────────────────

export function approvalTelegramText({ kind, token, clientName, quoteNumber, amount, leadId }) {
  const head = kind === 'payment_verify'
    ? ['💰 אסמכתת תשלום ממתינה לאישור',
       `לקוח: ${clientName ?? '—'}`,
       `הזמנה: ${quoteNumber ?? '—'}`,
       ...(amount !== null && amount !== undefined && amount !== '' ? [`סכום: ₪${amount}`] : [])]
    : ['📄 הלקוח סיים לערוך תכנים — לאשר התחלת עבודה?',
       `לקוח: ${clientName ?? '—'}`,
       `הזמנה: ${quoteNumber ?? '—'}`];
  return [
    ...head,
    '',
    // The link opens a side-effect-free GET page (Telegram prefetches links);
    // the real approval is that page's POST button.
    `אישור: ${publicBaseUrl()}/approve/${token}`,
    `פאנל: ${boosterLeadPanelUrl(leadId)}`,
  ].join('\n');
}

// The webhook-facing entry point. Outcomes:
//   'telegram' — record created, message delivered
//   'skipped'  — permanent local condition (no Telegram env / no business id):
//                log loudly, ack the webhook, lean on the booster's own alert
//   'failed'   — transient (Telegram API down/slow): the webhook 502s so the
//                booster's outbox retries with the same event_id
export async function requestProcessApproval({ kind, leadId, quoteNumber, clientName, phone, amount, context }) {
  if (!telegramConfigured()) {
    console.warn('[process-approval] Telegram env missing — approval request logged only:', kind, 'lead', leadId);
    return 'skipped';
  }
  try {
    const token = await createProcessApproval({
      businessId: process.env.DIVAZ_BUSINESS_ID ?? null,
      kind, leadId, quoteNumber, clientName, phone, amount, context,
    });
    if (!token) return 'skipped'; // no business id on this deploy — permanent
    if (await sendTelegramText(approvalTelegramText({ kind, token, clientName, quoteNumber, amount, leadId }))) {
      return 'telegram';
    }
    console.error('[process-approval] telegram send not ok:', kind, 'lead', leadId);
  } catch (e) {
    console.error('[process-approval] telegram notify failed:', e.message);
  }
  return 'failed';
}
