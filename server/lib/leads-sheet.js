// Google-Sheet → leads board sync (the trial-registration form's landing
// sheet is the registration source of truth for TRIAL DATES).
//
// Generic per-business setting on the `leads` module row (business_modules):
//   settings.sheet_file_id  — the Drive file id of the sheet (required)
//   settings.sheet_gid      — optional tab gid (default: first sheet)
//
// The sheet is read as CSV through the divazuc platform Google identity
// (lib/google-token.js). Column mapping is HEADER-BASED and tolerant of the
// Hebrew variants a site form produces (טלפון/נייד, שם, תאריך/מועד, שעה,
// שם הילד, גיל) — unmatched headers are logged, never fatal.
//
// Sync = upsert by normalized phone:
//   - new number → a fresh lead, source 'form', status 'trial_signed_up'
//   - existing lead → payload merge (trial_date / trial_time / child fields),
//     status auto-laddered via nextAutoStatus — NEVER downgraded, and a human
//     mark (not_relevant) is never overwritten. Same iron rules as lib/leads.js.
//
// Runs in two places: the daily /cron/trial-reminders hit (before the 09:00
// reminder pass) and the board's manual "סנכרון מהגיליון" button (portal +
// studio ops). Cron-path callers treat a failure as soft; the manual op THROWS
// so the operator sees it.
import { nextAutoStatus } from './leads.js';

// ── CSV parsing (quoted cells, CRLF, embedded commas/newlines) ───────────────

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQ = false;
  const s = String(text ?? '').replace(/^﻿/, ''); // strip a leading BOM
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; }
        else inQ = false;
      } else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ── Header detection (Hebrew-first, tolerant) ────────────────────────────────
// Order matters, and every rule below exists because of a real sheet header:
//   'גיל הילד'    must map to age (contains 'ילד' too);
//   'תאריך ושעה'  is the FORM SUBMISSION timestamp — 'תאריך'+'שעה' TOGETHER
//                 must claim it before the trial date/time matchers see it;
//   'מועד ניסיון' is the trial SLOT (may hold a combined "…12/08/2026 · בשעה
//                 16:00" string — the parsers below pull date+time out of it);
//   'יום מועדף'   must NOT be mistaken for a trial date ('מועדף' ⊃ 'מועד').

const FIELD_ORDER = [
  'child_age', 'child_name', 'submitted_at', 'trial_time', 'trial_date',
  'phone', 'group', 'note', 'utm_source', 'utm_campaign', 'parent_name',
];
const FIELD_MATCHERS = {
  child_age:    (h) => h.includes('גיל') || h.includes('age'),
  child_name:   (h) => h.includes('ילד') || h.includes('child'),
  submitted_at: (h) => h.includes('תאריך') && h.includes('שעה'),
  trial_time:   (h) => h.includes('שעה') || h.includes('time'),
  trial_date:   (h) => h.includes('תאריך') || (h.includes('מועד') && !h.includes('מועדף')) || h.includes('date'),
  phone:        (h) => h.includes('טלפון') || h.includes('נייד') || h.includes('פלאפון') || h.includes('phone'),
  group:        (h) => h.includes('קבוצה'),
  note:         (h) => h.includes('הערות') || h.includes('הערה'),
  utm_source:   (h) => h.includes('utm_source'),
  utm_campaign: (h) => h.includes('utm_campaign'),
  parent_name:  (h) => h.includes('שם') || h.includes('name'),
};

export function mapHeaders(headerCells) {
  const map = {};       // column index → field
  const unmatched = [];
  headerCells.forEach((raw, i) => {
    const h = String(raw ?? '').trim().toLowerCase();
    if (!h) return;
    const field = FIELD_ORDER.find(f => !Object.values(map).includes(f) && FIELD_MATCHERS[f](h));
    if (field) map[i] = field;
    else unmatched.push(String(raw).trim());
  });
  return { map, unmatched };
}

// ── Cell normalization ───────────────────────────────────────────────────────

// '050-123 4567' / '+972501234567' / '501234567' → '972501234567'; junk → null.
export function normalizeSheetPhone(raw) {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('0')) digits = '972' + digits.slice(1);
  else if (digits.length === 9 && digits.startsWith('5')) digits = '972' + digits;
  return /^\d{10,15}$/.test(digits) ? digits : null;
}

// Tolerant date extraction — works for a clean cell ('2026-08-14',
// '14/08/2026', '14.8.26') AND for the form's combined slot string
// ('יום רביעי 12/08/2026 · בשעה 16:00'): the FIRST date-looking token wins.
export function parseTrialDate(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let y, m, d;
  let match = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) [, y, m, d] = match.map(Number);
  else {
    match = s.match(/(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})/);
    if (!match) return null;
    [, d, m, y] = match.map(Number);
    if (y < 100) y += 2000;
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Tolerant time extraction. A whole-cell value accepts '16:30' / '16.30' /
// '9:00:00'; inside a longer slot string only the ':' form counts ('…בשעה
// 16:00') — a '.' search would false-match the date's own digits.
export function parseTrialTime(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?$/);
  if (!m) m = s.match(/(?:^|[^\d:.])(\d{1,2}):(\d{2})(?![\d:])/);
  if (!m) return null;
  const h = Number(m[1]);
  return h <= 23 && Number(m[2]) <= 59 ? `${h}:${m[2]}` : null;
}

// ── Sheet → structured rows ──────────────────────────────────────────────────

/**
 * CSV text → { rows, skipped, unmatchedHeaders }. A row without a usable
 * phone is skipped (and logged); a row with an unparseable trial date keeps
 * its other fields — the date is simply absent, so no reminder will fire.
 */
export function parseSheetCsv(csvText) {
  const table = parseCsv(csvText);
  if (!table.length) return { rows: [], skipped: 0, unmatchedHeaders: [] };

  const { map, unmatched } = mapHeaders(table[0]);
  if (unmatched.length) {
    console.warn('[leads-sheet] unmatched sheet headers (ignored):', unmatched.join(' | '));
  }
  if (!Object.values(map).includes('phone')) {
    console.error('[leads-sheet] no phone column detected — nothing to sync. headers:', table[0].join(' | '));
    return { rows: [], skipped: Math.max(0, table.length - 1), unmatchedHeaders: unmatched };
  }

  const rows = [];
  let skipped = 0;
  for (let r = 1; r < table.length; r++) {
    const cells = table[r];
    if (!cells.some(c => String(c ?? '').trim() !== '')) continue; // blank line, not an error
    const raw = {};
    for (const [i, field] of Object.entries(map)) raw[field] = String(cells[i] ?? '').trim();

    const phone = normalizeSheetPhone(raw.phone);
    if (!phone) {
      skipped++;
      console.warn(`[leads-sheet] row ${r + 1} skipped — unusable phone: "${raw.phone ?? ''}"`);
      continue;
    }
    // The trial-slot cell may be a clean date, a combined "יום רביעי
    // 12/08/2026 · בשעה 16:00" slot string, or empty ("coordinate later") —
    // empty is a normal signup, it simply has no date for a reminder to key on.
    const trial_date = parseTrialDate(raw.trial_date);
    if (raw.trial_date && !trial_date) {
      console.warn(`[leads-sheet] row ${r + 1}: unparseable trial date "${raw.trial_date}" — syncing the row without it`);
    }
    rows.push({
      phone,
      parent_name: raw.parent_name || null,
      child_name:  raw.child_name || null,
      child_age:   raw.child_age || null,
      trial_date,
      trial_time:  parseTrialTime(raw.trial_time) ?? parseTrialTime(raw.trial_date),
      group:        raw.group || null,
      note:         raw.note || null,
      utm_source:   raw.utm_source || null,
      utm_campaign: raw.utm_campaign || null,
      submitted_at: raw.submitted_at || null,
    });
  }
  return { rows, skipped, unmatchedHeaders: unmatched };
}

// ── DB + fetch seams ─────────────────────────────────────────────────────────

let db = null; // test seam
export function _setDbForTest(fake) { db = fake; }

async function realDb() {
  const { supabase } = await import('./supabase.js');
  return {
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
  };
}

const getDb = async () => db ?? await realDb();

// CSV download seam — tests hand back fixture text instead of hitting Google.
let csvFetcher = null;
export function _setCsvFetcherForTest(fn) { csvFetcher = fn; }

async function fetchSheetCsv(fileId, gid) {
  if (csvFetcher) return csvFetcher(fileId, gid);
  const { getGoogleAccessToken } = await import('./google-token.js');
  const token = await getGoogleAccessToken();
  // The docs.google.com export URL is preferred over the Drive API export —
  // it honors ?gid= (Drive's export always serves the first tab) and accepts
  // the same bearer token; verified against the real registration sheet.
  const gidParam = (gid !== undefined && gid !== null && gid !== '')
    ? `&gid=${encodeURIComponent(gid)}` : '';
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(fileId)}/export?format=csv${gidParam}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`sheet export failed: HTTP ${res.status}`);
  return res.text();
}

// ── The sync itself ──────────────────────────────────────────────────────────

const sheetHistoryEntry = (from, to, atIso) => ({ from: from ?? null, to, at: atIso, by: 'sheet' });

// payload keys the sheet may write — a sheet row can never smuggle other keys.
const SHEET_PAYLOAD_FIELDS = [
  'parent_name', 'child_name', 'child_age', 'trial_date', 'trial_time',
  'group', 'note', 'utm_source', 'utm_campaign', 'submitted_at',
];

/**
 * Upsert one parsed sheet row. Exported for tests; syncSheetLeads drives it.
 * Merge rules: sheet values win for the trial fields they carry (the sheet is
 * the registration source of truth), but an empty sheet cell never blanks an
 * existing value.
 */
export async function upsertSheetRow(businessId, row, now = new Date()) {
  const d = await getDb();
  const nowIso = now.toISOString();
  const clean = {};
  for (const k of SHEET_PAYLOAD_FIELDS) if (row[k]) clean[k] = String(row[k]);

  const existing = await d.getLead(businessId, row.phone);
  if (!existing) {
    await d.insertLead({
      business_id: businessId, phone: row.phone,
      display_name: row.parent_name ?? null,
      status: 'trial_signed_up', source: 'form',
      first_contact_at: nowIso, last_contact_at: nowIso, last_direction: 'in',
      payload: clean,
      status_history: [sheetHistoryEntry(null, 'trial_signed_up', nowIso)],
    });
    return { created: true, updated: true };
  }

  const payload = { ...(existing.payload ?? {}), ...clean };
  const patch = {};
  if (JSON.stringify(payload) !== JSON.stringify(existing.payload ?? {})) patch.payload = payload;
  if (!existing.display_name && row.parent_name) patch.display_name = row.parent_name;
  const advanced = nextAutoStatus(existing.status, 'trial_signed_up');
  if (advanced) {
    patch.status = advanced;
    patch.status_history = [...(Array.isArray(existing.status_history) ? existing.status_history : []),
      sheetHistoryEntry(existing.status, advanced, nowIso)];
  }
  if (!Object.keys(patch).length) return { created: false, updated: false };
  await d.updateLead(existing.id, patch);
  return { created: false, updated: true };
}

/**
 * Full sync for one business. THROWS on operator-visible failures (no module,
 * no sheet configured, unreachable sheet) — the cron caller wraps it in its
 * own try/catch, the manual ops surface the message.
 * Returns { synced: true, updated, created, skipped } — `updated` counts every
 * lead the sync actually changed (created included), which is the number the
 * board's toast shows.
 */
export async function syncSheetLeads(businessId, { now = new Date() } = {}) {
  const d = await getDb();
  const module_ = await d.getLeadsModule(businessId);
  if (!module_?.enabled) { const e = new Error('leads module is not enabled'); e.status = 400; throw e; }
  const fileId = module_.settings?.sheet_file_id;
  if (!fileId) { const e = new Error('no sheet configured (settings.sheet_file_id)'); e.status = 400; throw e; }

  const csv = await fetchSheetCsv(fileId, module_.settings?.sheet_gid);
  const { rows, skipped } = parseSheetCsv(csv);

  let updated = 0, created = 0;
  for (const row of rows) {
    const out = await upsertSheetRow(businessId, row, now);
    if (out.updated) updated++;
    if (out.created) created++;
  }
  console.log(`[leads-sheet] synced business=${businessId}: ${rows.length} rows, ${updated} leads updated (${created} new), ${skipped} skipped`);
  return { synced: true, updated, created, skipped };
}
