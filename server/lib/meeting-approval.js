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
import { hashToken, mintToken, TOKEN_RE, telegramConfigured, publicBaseUrl, sendTelegramText } from './approvals.js';
import { normalizeIlPhone } from './booster-client.js';
import { hebDateDMY } from './heb-date.js';

// The token/Telegram plumbing moved to lib/approvals.js when process
// approvals (lib/process-approval.js) arrived — re-exported here so this
// module's public API (and its tests) stay exactly what they were.
export { hashToken, telegramConfigured, publicBaseUrl, TELEGRAM_TIMEOUT_MS, _setTelegramFetchForTest } from './approvals.js';

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
export async function createMeetingApproval({ businessId, eventId, calendarRowId, phone, name, slot, quoteNumber, clientEmail, replacesEventId = null, replacesSlot = null }) {
  // module_events.business_id is NOT NULL — same hard precondition as the
  // meeting notes (lib/booster-meeting.js#recordMeetingEvent).
  if (!businessId) {
    console.error('[meeting-approval] not creating an approval — no business id');
    return null;
  }
  const token = mintToken();
  const row = {
    business_id: businessId, module_key: 'calendar', event_type: 'meeting_approval',
    created_at: new Date().toISOString(),
    detail: {
      token_hash: hashToken(token), status: 'pending',
      event_id: eventId ?? null, calendar_row_id: calendarRowId ?? null,
      phone: normalizeIlPhone(phone), name: name ?? null, slot,
      quote_number: quoteNumber ?? null, client_email: clientEmail ?? null,
      // A reschedule request: the confirmed meeting that leaves the calendar
      // if — and only if — this one is approved (owner, 2026-08-29).
      replaces_event_id: replacesEventId ?? null, replaces_slot: replacesSlot ?? null,
    },
  };
  if (db) { db.events.push(row); return token; }
  await (await realDb()).insertEvent(row);
  return token;
}

export async function findApprovalByToken(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
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

const HEB_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
export function slotParts(slot) {
  const [date, from] = String(slot ?? '').split('T');
  return { date, from, day: HEB_DAYS[new Date(`${date}T00:00:00`).getDay()] ?? '' };
}

export async function sendTelegramApproval({ token, name, phone, slot, quoteNumber, replacesSlot = null }) {
  const { date, from, day } = slotParts(slot);
  const base = publicBaseUrl();
  // Both links open the same GET page — it is side-effect-free (Telegram
  // prefetches links), and the real approve/reschedule are its POST buttons.
  const prev = replacesSlot ? slotParts(replacesSlot) : null;
  const text = [
    prev ? '🔁 בקשת שינוי מועד' : '📅 בקשת פגישה חדשה',
    `שם: ${name ?? '—'}`,
    `טלפון: ${phone ?? '—'}`,
    ...(prev ? [`מועד קודם: יום ${prev.day} ${hebDateDMY(prev.date)} בשעה ${prev.from} (יוסר מהיומן עם האישור)`] : []),
    `${prev ? 'מועד מבוקש' : 'מועד'}: יום ${day} ${hebDateDMY(date)} בשעה ${from}`,
    ...(quoteNumber ? [`הזמנה: ${quoteNumber}`] : []),
    '',
    `אישור: ${base}/meeting/${token}?a=approve`,
    `שינוי מועד: ${base}/meeting/${token}?a=reschedule`,
  ].join('\n');
  return sendTelegramText(text);
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
export async function requestOwnerApproval({ business, calendarRowId, ownerNotifyPhone, eventId, phone, name, slot, quoteNumber, clientEmail, replacesEventId = null, replacesSlot = null }) {
  try {
    if (telegramConfigured()) {
      const token = await createMeetingApproval({
        businessId: business.id, eventId, calendarRowId, phone, name, slot, quoteNumber, clientEmail, replacesEventId, replacesSlot,
      });
      if (token && await sendTelegramApproval({
        token, name, phone: normalizeIlPhone(phone) ?? phone, slot, quoteNumber, replacesSlot,
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
