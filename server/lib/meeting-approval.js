// Owner approval for a TENTATIVE calendar booking (owner_confirmed mode):
// Telegram one-tap links backed by one-time tokens.
//
// Flow: calendar.book (tentative) → an approval record in module_events
// (event_type meeting_approval; the token is stored ONLY as a SHA-256 hash —
// the raw token exists nowhere but inside the Telegram message, exactly like
// the booster's /q tokens) → the owner taps אישור / שינוי מועד → the public
// routes in routes/meeting-approval.js consume the record exactly once.
//
// Failure discipline: this whole file is a NOTIFICATION layer on top of a
// booking that already succeeded. requestOwnerApproval never throws into the
// booking path, and a missing Telegram env degrades to the pre-Telegram
// WhatsApp owner notify rather than to silence.
import crypto from 'node:crypto';
import { normalizeIlPhone } from './booster-client.js';

export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// module_events store seam — same convention as lib/booster-meeting.js: the
// fake is { events: [] } (insertion order stands in for created_at);
// production reads/writes the real table.
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
        .eq('event_type', 'meeting_approval')
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

// Returns the RAW token (for the Telegram links) — only its hash is stored.
export async function createMeetingApproval({ businessId, eventId, calendarRowId, phone, name, slot, quoteNumber, clientEmail }) {
  // module_events.business_id is NOT NULL — same hard precondition as the
  // meeting notes (lib/booster-meeting.js#recordMeetingEvent).
  if (!businessId) {
    console.error('[meeting-approval] not creating an approval — no business id');
    return null;
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const row = {
    business_id: businessId, module_key: 'calendar', event_type: 'meeting_approval',
    created_at: new Date().toISOString(),
    detail: {
      token_hash: hashToken(token), status: 'pending',
      event_id: eventId ?? null, calendar_row_id: calendarRowId ?? null,
      phone: normalizeIlPhone(phone), name: name ?? null, slot,
      quote_number: quoteNumber ?? null, client_email: clientEmail ?? null,
    },
  };
  if (db) { db.events.push(row); return token; }
  await (await realDb()).insertEvent(row);
  return token;
}

export async function findApprovalByToken(token) {
  // base64url of 32 bytes is 43 chars — anything wildly off never hits the db.
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const hash = hashToken(token);
  if (db) {
    const rows = db.events.filter(r => r.event_type === 'meeting_approval' && r.detail?.token_hash === hash);
    return rows.length ? rows[rows.length - 1] : null;
  }
  return (await realDb()).findByTokenHash(hash);
}

// Either action consumes the token — single-use overall.
export async function consumeApproval(row, status) {
  const detail = { ...row.detail, status, consumed_at: new Date().toISOString() };
  if (db) { row.detail = detail; return; }
  await (await realDb()).updateDetail(row.id, detail);
}

// ── Telegram ─────────────────────────────────────────────────────────────────

export function telegramConfigured(env = process.env) {
  return !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
}

// Same convention as google.js / studio.js — the Railway domain is the
// fallback when PUBLIC_BASE_URL is unset.
export function publicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL ?? 'https://wagent.divdev.co').replace(/\/$/, '');
}

// Telegram HTTP seam — tests record the request instead of hitting the API.
let telegramFetch = null;
export function _setTelegramFetchForTest(fn) { telegramFetch = fn; }

const HEB_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
export function slotParts(slot) {
  const [date, from] = String(slot ?? '').split('T');
  return { date, from, day: HEB_DAYS[new Date(`${date}T00:00:00`).getDay()] ?? '' };
}

// A hung Telegram API must not hold the booking reply's process hostage.
export const TELEGRAM_TIMEOUT_MS = 3500;

export async function sendTelegramApproval({ token, name, phone, slot, quoteNumber }) {
  const { date, from, day } = slotParts(slot);
  const base = publicBaseUrl();
  // Both links open the same GET page — it is side-effect-free (Telegram
  // prefetches links), and the real approve/reschedule are its POST buttons.
  const text = [
    '📅 בקשת פגישה חדשה',
    `שם: ${name ?? '—'}`,
    `טלפון: ${phone ?? '—'}`,
    `מועד: יום ${day} ${date} בשעה ${from}`,
    ...(quoteNumber ? [`הזמנה: ${quoteNumber}`] : []),
    '',
    `אישור: ${base}/meeting/${token}?a=approve`,
    `שינוי מועד: ${base}/meeting/${token}?a=reschedule`,
  ].join('\n');
  const doFetch = telegramFetch ?? fetch;
  const res = await doFetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text }),
    signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
  });
  return !!res?.ok;
}

// ── WhatsApp fallback ────────────────────────────────────────────────────────

// Lazy import like lib/relay: wa-send pulls in supabase, which a unit test
// must never load. The seam replaces the send entirely.
let waSend = null;
export function _setWaSendForTest(fn) { waSend = fn; }
async function sendWa(args) {
  const fn = waSend ?? (await import('./wa-send.js')).sendWhatsAppMessage;
  return fn(args);
}

// The owner-notify step of a tentative booking. Telegram (one-tap links) is
// primary; the pre-Telegram WhatsApp notify is the fallback for a missing env
// or ANY failure along the Telegram path. Never throws: by the time this runs
// the client's booking already succeeded, so a notification problem is the
// owner's action item, never the client's.
export async function requestOwnerApproval({ business, calendarRowId, ownerNotifyPhone, eventId, phone, name, slot, quoteNumber, clientEmail }) {
  try {
    if (telegramConfigured()) {
      const token = await createMeetingApproval({
        businessId: business.id, eventId, calendarRowId, phone, name, slot, quoteNumber, clientEmail,
      });
      if (token && await sendTelegramApproval({
        token, name, phone: normalizeIlPhone(phone) ?? phone, slot, quoteNumber,
      })) return 'telegram';
    }
  } catch (e) {
    console.error('[meeting-approval] telegram notify failed — falling back to the WhatsApp owner notify:', e.message);
  }
  if (!ownerNotifyPhone) return 'none';
  try {
    // The pre-Telegram notify, byte-for-byte (was inline in the calendar module).
    const { date, from } = slotParts(slot);
    await sendWa({
      to: ownerNotifyPhone,
      text: `📅 בקשת פגישה חדשה: ${name} (${phone}) — ${date} בשעה ${from}. האירוע ביומן מסומן "ממתין לאישור".`,
      businessId: business.id,
    });
    return 'whatsapp';
  } catch (e) {
    console.error('[meeting-approval] whatsapp owner notify failed:', e.message);
    return 'none';
  }
}
