// Leads management (ניהול לידים) — the per-business lead board the client
// portal shows: EVERY number that wrote to the bot, with a status that the
// WhatsApp conversation itself advances. Built for the CrossFit Kids tenant
// first (replaces the coach's Google Sheet) but module-gated like everything
// else: a business without the `leads` module in business_modules is untouched.
//
// Three automatic transitions, all fed by existing seams:
//   first inbound customer message  → upsert, status 'new'   (index.js pipeline)
//   owner echo in the conversation  → 'contacted'            (lib/coexistence.js)
//   trial_signup action success     → 'trial_signed_up'      (lib/modules/trial-signup.js)
// 'attended' / 'joined' / 'not_relevant' are manual-only (portal UI → PATCH).
//
// Iron rules, same as the coexistence columns this convention comes from:
//   - every write FAILS SOFT — a missing `leads` table (DDL not applied yet:
//     wa-studio/docs/sql/2026-08-12-leads.sql), a disabled module, or a db
//     error must never break the reply pipeline;
//   - automatic progression NEVER downgrades a further-along status and never
//     touches a status a human chose (see lib/contact-status.js for the story
//     of why that rule exists);
//   - supabase.js is only ever lazy-imported, so tests run without env.

// ── Status model (v1 — the owner will refine) ────────────────────────────────
// Hebrew labels centralized HERE; the portal UI reads them off the API
// response rather than duplicating the copy.
export const LEAD_STATUSES = [
  { key: 'new',                label: 'חדש' },
  { key: 'contacted',          label: 'נוצר קשר' },
  { key: 'waitlist_next_date', label: 'לרשום למועד הבא' },
  { key: 'trial_signed_up',    label: 'נרשם לניסיון' },
  { key: 'attended',           label: 'הגיע לאימון' },
  { key: 'joined',             label: 'הצטרף' },
  { key: 'not_relevant',       label: 'לא רלוונטי' },
];
export const LEAD_STATUS_KEYS = LEAD_STATUSES.map(s => s.key);
export const leadStatusLabel = (key) =>
  LEAD_STATUSES.find(s => s.key === key)?.label ?? key;

// The ladder automatic progression climbs. 'not_relevant' is deliberately OFF
// it — it is a terminal human mark, so nextAutoStatus can neither set it nor
// overwrite it. 'attended'/'joined' are ON it (so no auto transition can pull
// a lead back below them) but no auto caller ever passes them as incoming.
// waitlist_next_date sits between contacted and trial_signed_up: wanting a
// trial with no open date is further along than merely being contacted, and a
// dated signup outranks it — so the sheet sync promotes a waitlisted lead the
// moment a date appears, and never the other way around.
const AUTO_LADDER = ['new', 'contacted', 'waitlist_next_date', 'trial_signed_up', 'attended', 'joined'];

/**
 * The status an AUTOMATIC transition may write, or null to leave the lead
 * alone. Never downgrades; never touches an off-ladder (human) status.
 */
export function nextAutoStatus(existing, incoming) {
  const to = AUTO_LADDER.indexOf(incoming);
  if (to === -1) return null;                    // auto never writes off-ladder statuses
  if (!existing) return incoming;
  const from = AUTO_LADDER.indexOf(existing);
  if (from === -1) return null;                  // a human mark (e.g. not_relevant) — not ours
  return to > from ? incoming : null;
}

const historyEntry = (from, to, by, atIso) => ({ from: from ?? null, to, at: atIso, by });
const appendHistory = (history, entry) => [...(Array.isArray(history) ? history : []), entry];

// Same guard as index.js#upsertContact: studio/test sessions ride synthetic
// session ids — only real phone numbers belong on the client's lead board.
const isRealPhone = (phone) => /^\d{10,15}$/.test(String(phone ?? ''));

// Trial fields that may live in payload — shared by the trial_signup merge and
// the PATCH whitelist so the portal cannot stuff arbitrary keys into the row.
const PAYLOAD_FIELDS = ['parent_name', 'child_name', 'child_age', 'preferred_day', 'note'];
function cleanPayloadFields(fields) {
  const out = {};
  for (const k of PAYLOAD_FIELDS) {
    if (fields?.[k] !== undefined && fields[k] !== null && String(fields[k]).trim() !== '') {
      out[k] = String(fields[k]).trim();
    }
  }
  return out;
}

// ── DB seam ──────────────────────────────────────────────────────────────────
let db = null; // test seam
export function _setDbForTest(fake) { db = fake; }

async function realDb() {
  const { supabase } = await import('./supabase.js');
  return {
    async isEnabled(businessId) {
      const { data, error } = await supabase.from('business_modules')
        .select('enabled').eq('business_id', businessId).eq('module_key', 'leads').maybeSingle();
      if (error) throw error;
      return data?.enabled === true;
    },
    // enabled + settings in one read — listLeadsForApi surfaces
    // settings.sheet_file_id as the board's sheet_configured flag.
    async getLeadsModule(businessId) {
      const { data, error } = await supabase.from('business_modules')
        .select('enabled, settings').eq('business_id', businessId).eq('module_key', 'leads').maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
    async getLead(businessId, phone) {
      const { data, error } = await supabase.from('leads').select('*')
        .eq('business_id', businessId).eq('phone', phone).maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
    async getLeadById(businessId, id) {
      const { data, error } = await supabase.from('leads').select('*')
        .eq('business_id', businessId).eq('id', id).maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
    async insertLead(row) {
      const { data, error } = await supabase.from('leads').insert(row).select('*').maybeSingle();
      if (error) throw error;
      return data;
    },
    async updateLead(id, patch) {
      const { error } = await supabase.from('leads')
        .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
      if (error) throw error;
    },
    async listLeads(businessId) {
      const { data, error } = await supabase.from('leads').select('*')
        .eq('business_id', businessId)
        .order('last_contact_at', { ascending: false, nullsFirst: false })
        .limit(1000);
      if (error) throw error;
      return data ?? [];
    },
    // The lead's WhatsApp transcript — live sessions are keyed by phone, and
    // the business_id filter keeps one tenant's thread out of another's board.
    // Last 200 turns, returned oldest-first (fetch newest-first, then flip).
    async listConversation(businessId, phone) {
      const { data, error } = await supabase.from('conversation_messages')
        .select('user_message, agent_response, action, created_at')
        .eq('business_id', businessId).eq('session_id', phone)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []).reverse();
    },
  };
}

const getDb = async () => db ?? await realDb();

// ── Automatic transitions (reply-pipeline side — every one fails SOFT) ───────

/**
 * Every inbound customer message for a leads-enabled business lands here
 * (fire-and-forget from index.js, ABOVE the reply gates — after-hours and the
 * owner standdown silence the bot, never the board). First message creates
 * the lead as 'new'; every message refreshes last_contact_at/last_direction.
 */
export async function recordInboundMessage({ businessId, phone, profileName = null, now = new Date() }) {
  try {
    if (!businessId || !isRealPhone(phone)) return { recorded: false, reason: 'not_a_lead' };
    const d = await getDb();
    if (!(await d.isEnabled(businessId))) return { recorded: false, reason: 'module_disabled' };

    const nowIso = now.toISOString();
    const existing = await d.getLead(businessId, phone);
    if (!existing) {
      await d.insertLead({
        business_id: businessId, phone,
        display_name: profileName ?? null,
        status: 'new', source: 'whatsapp',
        first_contact_at: nowIso, last_contact_at: nowIso, last_direction: 'in',
        payload: {}, status_history: [],
      });
      return { recorded: true, created: true };
    }
    const patch = { last_contact_at: nowIso, last_direction: 'in' };
    if (!existing.display_name && profileName) patch.display_name = profileName;
    await d.updateLead(existing.id, patch);
    return { recorded: true, created: false };
  } catch (e) {
    console.error('[leads] inbound bookkeeping failed (reply pipeline unaffected):', e.message);
    return { recorded: false, reason: 'error' };
  }
}

/**
 * The owner personally answered this conversation from the WhatsApp Business
 * app (a coexistence echo) — that IS the "נוצר קשר" signal. Called from
 * lib/coexistence.js#handleOwnerEcho AFTER the coexistence gate passed, so
 * this fires only for coexistence businesses, and only advances new →
 * contacted (a lead already further along keeps its status; only the
 * last-contact bookkeeping updates).
 */
export async function recordOwnerEcho({ businessId, phone, now = new Date() }) {
  try {
    if (!businessId || !isRealPhone(phone)) return { recorded: false, reason: 'not_a_lead' };
    const d = await getDb();
    if (!(await d.isEnabled(businessId))) return { recorded: false, reason: 'module_disabled' };

    const nowIso = now.toISOString();
    const existing = await d.getLead(businessId, phone);
    if (!existing) {
      // The owner opened the conversation from the app before the customer
      // ever wrote — still a number the board should track, already contacted.
      await d.insertLead({
        business_id: businessId, phone, display_name: null,
        status: 'contacted', source: 'whatsapp',
        first_contact_at: nowIso, last_contact_at: nowIso, last_direction: 'out',
        payload: {}, status_history: [historyEntry(null, 'contacted', 'auto', nowIso)],
      });
      return { recorded: true, created: true };
    }
    const patch = { last_contact_at: nowIso, last_direction: 'out' };
    const advanced = nextAutoStatus(existing.status, 'contacted');
    if (advanced) {
      patch.status = advanced;
      patch.status_history = appendHistory(existing.status_history,
        historyEntry(existing.status, advanced, 'auto', nowIso));
    }
    await d.updateLead(existing.id, patch);
    return { recorded: true, advanced: advanced ?? null };
  } catch (e) {
    console.error('[leads] owner-echo bookkeeping failed (standdown unaffected):', e.message);
    return { recorded: false, reason: 'error' };
  }
}

/**
 * A trial_signup action succeeded — the parent got the pinned confirmation
 * and the coach got the relay. Bank the structured fields on the lead row and
 * advance to 'trial_signed_up'. Called from the trial-signup module's own
 * handler (the one place that knows the action succeeded).
 */
export async function recordTrialSignup({ businessId, phone, fields, now = new Date() }) {
  try {
    if (!businessId || !isRealPhone(phone)) return { recorded: false, reason: 'not_a_lead' };
    const d = await getDb();
    if (!(await d.isEnabled(businessId))) return { recorded: false, reason: 'module_disabled' };

    const nowIso = now.toISOString();
    const clean = cleanPayloadFields(fields);
    const existing = await d.getLead(businessId, phone);
    if (!existing) {
      // Shouldn't happen (the inbound hook runs first) — but a signup must
      // never be lost to a race, so create the row fully formed.
      await d.insertLead({
        business_id: businessId, phone, display_name: null,
        status: 'trial_signed_up', source: 'whatsapp',
        first_contact_at: nowIso, last_contact_at: nowIso, last_direction: 'in',
        payload: clean, status_history: [historyEntry(null, 'trial_signed_up', 'auto', nowIso)],
      });
      return { recorded: true, created: true };
    }
    const patch = { payload: { ...(existing.payload ?? {}), ...clean } };
    const advanced = nextAutoStatus(existing.status, 'trial_signed_up');
    if (advanced) {
      patch.status = advanced;
      patch.status_history = appendHistory(existing.status_history,
        historyEntry(existing.status, advanced, 'auto', nowIso));
    }
    await d.updateLead(existing.id, patch);
    return { recorded: true, advanced: advanced ?? null };
  } catch (e) {
    console.error('[leads] trial-signup bookkeeping failed (confirmation unaffected):', e.message);
    return { recorded: false, reason: 'error' };
  }
}

// ── Portal/studio API (these THROW — an operator error should be seen) ───────

const httpError = (message, status) => { const e = new Error(message); e.status = status; return e; };

// Pure helpers, exported for tests and shared with the CSV.
export function filterLeads(rows, { status = null, search = '' } = {}) {
  const q = String(search ?? '').trim().toLowerCase().replace(/-/g, '');
  return rows.filter(l => {
    if (status && l.status !== status) return false;
    if (q) {
      const local = String(l.phone ?? '').startsWith('972') ? '0' + String(l.phone).slice(3) : '';
      const hay = [l.phone, local, l.display_name, l.payload?.parent_name, l.payload?.child_name, l.notes]
        .filter(Boolean).join(' ').toLowerCase().replace(/-/g, '');
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function leadCounts(rows) {
  const counts = { all: rows.length };
  for (const s of LEAD_STATUS_KEYS) counts[s] = 0;
  for (const l of rows) if (counts[l.status] !== undefined) counts[l.status] += 1;
  return counts;
}

/**
 * The board, in one response: rows (filtered), counts per status (unfiltered —
 * the tabs), the status catalog (centralized Hebrew labels), and whether the
 * module is enabled at all (the portal hides the tab when it isn't).
 * `ready:false` means the leads TABLE is missing (DDL not applied yet) — the
 * portal shows the empty state rather than an error, same fail-soft posture
 * as the pipeline.
 */
export async function listLeadsForApi(businessId, { status = null, search = '' } = {}) {
  const base = { statuses: LEAD_STATUSES };
  const d = await getDb();
  // Older fakes implement only isEnabled — getLeadsModule additionally carries
  // settings, so the board knows a registration sheet is wired up
  // (sheet_configured drives the "סנכרון מהגיליון" button).
  let enabled = false, settings = {};
  try {
    if (typeof d.getLeadsModule === 'function') {
      const row = await d.getLeadsModule(businessId);
      enabled = row?.enabled === true;
      settings = row?.settings ?? {};
    } else {
      enabled = await d.isEnabled(businessId);
    }
  } catch { enabled = false; }
  base.sheet_configured = !!settings.sheet_file_id;
  if (!enabled) return { ...base, enabled: false, ready: true, leads: [], counts: leadCounts([]) };
  try {
    const rows = await d.listLeads(businessId);
    return { ...base, enabled: true, ready: true, leads: filterLeads(rows, { status, search }), counts: leadCounts(rows) };
  } catch (e) {
    console.error('[leads] list failed (table missing? apply docs/sql/2026-08-12-leads.sql):', e.message);
    return { ...base, enabled: true, ready: false, leads: [], counts: leadCounts([]) };
  }
}

/**
 * Manual edit from the board: status (history-appended, any status the model
 * knows — manual moves may go anywhere, including backwards), notes, and the
 * whitelisted trial payload fields. Business scoping comes from the caller's
 * token; a lead id outside that business 404s. No delete in v1.
 */
export async function applyLeadUpdate(businessId, id, { status, notes, payload } = {}, by = 'owner') {
  if (!businessId || !id) throw httpError('business and lead id required', 400);
  if (status !== undefined && !LEAD_STATUS_KEYS.includes(status)) {
    throw httpError(`unknown status: ${status}`, 400);
  }
  const d = await getDb();
  const existing = await d.getLeadById(businessId, id);
  if (!existing) throw httpError('not found', 404);

  const patch = {};
  const nowIso = new Date().toISOString();
  if (status !== undefined && status !== existing.status) {
    patch.status = status;
    patch.status_history = appendHistory(existing.status_history,
      historyEntry(existing.status, status, by, nowIso));
  }
  if (notes !== undefined) patch.notes = notes === null ? null : String(notes);
  if (payload !== undefined) {
    const clean = cleanPayloadFields(payload);
    if (Object.keys(clean).length) patch.payload = { ...(existing.payload ?? {}), ...clean };
  }
  if (Object.keys(patch).length) await d.updateLead(existing.id, patch);
  return { ...existing, ...patch };
}

/**
 * The in-app conversation view behind the board's phone click (the owner
 * works from a computer — never bounce her to wa.me). Business-scoped twice
 * over: the phone must be a lead ON THIS BUSINESS'S BOARD (a foreign
 * business's session 404s before any message is read), and the message query
 * itself filters by business_id. Rows with action 'owner_echo' are the
 * owner's own app replies (persisted by lib/coexistence.js) — the UI labels
 * them "המאמנת (מהאפליקציה)".
 */
export async function getLeadConversation(businessId, phone) {
  if (!businessId || !phone) throw httpError('business and phone required', 400);
  const d = await getDb();
  const lead = await d.getLead(businessId, String(phone));
  if (!lead) throw httpError('not found', 404);
  let messages = [];
  try {
    messages = await d.listConversation(businessId, String(phone));
  } catch (e) {
    // A missing/unreadable messages table degrades to the empty state — the
    // board itself must keep working.
    console.error('[leads] conversation load failed — returning an empty thread:', e.message);
  }
  return { messages };
}

// ── CSV export (the Google Sheet replacement) ────────────────────────────────

// Hebrew headers, UTF-8 BOM so Excel opens it right, CRLF rows.
const CSV_HEADERS = ['טלפון', 'שם', 'סטטוס', 'שם ההורה', 'שם הילד/ה', 'גיל', 'יום מועדף', 'פנייה ראשונה', 'פנייה אחרונה', 'הערות'];

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const localPhone = (p) => String(p ?? '').startsWith('972') ? '0' + String(p).slice(3) : String(p ?? '');

const csvDate = (iso) => {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('he-IL', {
      timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }).replace(', ', ' '); // "10.08.2026, 11:00" → comma-free, so the cell needs no quoting
  } catch { return ''; }
};

export function leadsToCsv(rows) {
  const lines = [CSV_HEADERS.join(',')];
  for (const l of rows) {
    lines.push([
      localPhone(l.phone),
      l.display_name ?? l.payload?.parent_name ?? '',
      leadStatusLabel(l.status),
      l.payload?.parent_name ?? '',
      l.payload?.child_name ?? '',
      l.payload?.child_age ?? '',
      l.payload?.preferred_day ?? '',
      csvDate(l.first_contact_at),
      csvDate(l.last_contact_at),
      l.notes ?? '',
    ].map(csvCell).join(','));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export async function exportLeadsCsv(businessId) {
  const d = await getDb();
  let rows = [];
  try { rows = await d.listLeads(businessId); } catch (e) {
    console.error('[leads] csv export: no table yet — exporting empty board:', e.message);
  }
  const filename = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
  return { filename, csv: leadsToCsv(rows) };
}
