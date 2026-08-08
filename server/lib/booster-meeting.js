// Track 1 (funnel v1) — the meeting layer of the express funnel.
//
// Three concerns, one seam-friendly module (see the plan's T1 and
// docs/booster-meeting-scheduling-handoff.md):
//
//   1. Meeting NOTES — meeting_invite / meeting_booked rows in module_events
//      (no migration: the table already exists, schema verified against
//      wa-studio/docs/sql/2026-07-24-modules.sql — id, business_id,
//      module_key, event_type, detail jsonb, created_at). detail carries
//      {phone, quote_number, slot?}; a read means "the latest row per
//      (type, phone)". The invite note is also the ONLY place the bot knows
//      a lead's quote number from — the booster's by-ref lookup deliberately
//      doesn't return it (F5), so the event-title fallback chain lives here.
//
//   2. formatSlotOffer — the Hebrew slot text the booster webhook appends to
//      its own send_signed_summary / send_meeting_reminder message (one send,
//      not a follow-up). Never prices, never payment — the meeting offer is
//      the whole message.
//
//   3. gateCalendarBooking — the one-characterization-meeting guardrail
//      (handoff §2): express clients get exactly ONE meeting, at the
//      awaiting_meeting stage of their order. The gate sits in the reply
//      pipeline in front of executeModuleAction — the calendar module itself
//      stays generic (handoff: "החסם צריך לשבת בשכבת ההחלטה, לא ביומן").
import { getEnabledModules, logModuleEvent } from './modules/engine.js';
import * as boosterClientReal from './booster-client.js';
import { normalizeIlPhone } from './booster-client.js';

// Test seams — same convention as lib/payment-proof.js / lib/modules/booster.js.
let boosterClient = boosterClientReal;
export function _setBoosterClientForTest(fake) { boosterClient = fake ?? boosterClientReal; }

// module_events store seam. The fake is `{ events: [] }` (rows in insertion
// order — insertion order stands in for created_at); production reads/writes
// the real table. Same engine-style split as lib/modules/engine.js's db seam.
let db = null;
export function _setDbForTest(fake) { db = fake; }

async function realDb() {
  const { supabase } = await import('./supabase.js');
  return {
    async insertEvent(row) {
      const { error } = await supabase.from('module_events').insert(row);
      if (error) throw error;
    },
    async latestEvent({ businessId, type, phone }) {
      // created_at exists (NOT NULL DEFAULT now()) — order by it, with id as
      // the tiebreaker for same-timestamp rows.
      let q = supabase.from('module_events').select('*')
        .eq('module_key', 'booster').eq('event_type', type)
        .eq('detail->>phone', phone)
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .limit(1);
      if (businessId) q = q.eq('business_id', businessId);
      const { data, error } = await q;
      if (error) throw error;
      return data?.[0] ?? null;
    },
  };
}

// ── Meeting notes ────────────────────────────────────────────────────────────

// Phones arrive in two shapes — the booster's 05XXXXXXXX (webhook lead.phone)
// and WhatsApp's 972XXXXXXXXX (sessionCtx.session_id). Everything is stored
// and matched in the normalized 05… form so the two always meet.
async function recordMeetingEvent(eventType, { businessId, phone, quoteNumber, slot }) {
  const normalized = normalizeIlPhone(phone);
  if (!normalized) {
    console.error(`[booster-meeting] not recording ${eventType} — unparseable phone:`, phone);
    return false;
  }
  const row = {
    business_id: businessId ?? null,
    module_key: 'booster',
    event_type: eventType,
    detail: { phone: normalized, quote_number: quoteNumber ?? null, ...(slot ? { slot } : {}) },
  };
  try {
    if (db) { db.events.push(row); db.onInsert?.(row); return true; }
    await (await realDb()).insertEvent(row);
    return true;
  } catch (e) {
    console.error(`[booster-meeting] could not record ${eventType}:`, e.message);
    return false;
  }
}

export const recordMeetingInvite = (args) => recordMeetingEvent('meeting_invite', args);
export const recordMeetingBooked = (args) => recordMeetingEvent('meeting_booked', args);

// Latest row per (type, phone), or null — including on ANY failure. Both
// callers want exactly that: the webhook's reminder suppression sends the
// reminder when it cannot know (fail-open), and the gate treats "can't read
// the notes" as "no note" rather than blocking a real client.
export async function getLatestMeetingEvent({ businessId = null, type, phone }) {
  const normalized = normalizeIlPhone(phone);
  if (!normalized) return null;
  try {
    if (db) {
      const rows = db.events.filter(r =>
        r.module_key === 'booster' && r.event_type === type &&
        r.detail?.phone === normalized &&
        (!businessId || r.business_id === businessId));
      return rows.length ? rows[rows.length - 1] : null;
    }
    return await (await realDb()).latestEvent({ businessId, type, phone: normalized });
  } catch (e) {
    console.error('[booster-meeting] latest-event read failed — treating as none:', e.message);
    return null;
  }
}

// ── Slot offer copy ──────────────────────────────────────────────────────────

const HEB_DAYS = ['יום ראשון', 'יום שני', 'יום שלישי', 'יום רביעי', 'יום חמישי', 'יום שישי', 'שבת'];
const MAX_OFFER_DAYS = 3;
const MAX_TIMES_PER_DAY = 3;

// Turns real computed slots ([{date, from, to}], the calendar module's shape)
// into the offer block appended to the booster's own message. Returns null
// when there is nothing real to offer — the caller then sends today's copy
// unchanged rather than inventing availability.
export function formatSlotOffer(slots, { quoteNumber } = {}) {
  if (!Array.isArray(slots) || slots.length === 0) return null;
  const byDay = new Map();
  for (const s of slots) {
    if (!s?.date || !s?.from) continue;
    if (!byDay.has(s.date)) {
      if (byDay.size >= MAX_OFFER_DAYS) break; // slots arrive date-sorted
      byDay.set(s.date, []);
    }
    const times = byDay.get(s.date);
    if (times.length < MAX_TIMES_PER_DAY) times.push(s.from);
  }
  if (!byDay.size) return null;
  const lines = [...byDay.entries()].map(([date, times]) =>
    `- ${HEB_DAYS[new Date(`${date}T00:00:00`).getDay()]} ${date}: ${times.join(', ')}`);
  const orderRef = quoteNumber ? ` (הזמנה ${quoteNumber})` : '';
  return `יש לי כמה מועדים פנויים לפגישת האפיון שלנו${orderRef}:\n${lines.join('\n')}\nאיזה מועד נוח לך? אפשר פשוט לענות לי כאן 🙂`;
}

// ── The one-meeting gate ─────────────────────────────────────────────────────

// F6 — locked copy. The client is never told "blocked"; they get the same
// fixed line the callback escalation uses, and Diva gets the relay ping.
export const BLOCKED_REPLY = 'דיוה תחזור אליך בהקדם 🙂';

// Decision policy (the plan's "מדיניות שער ההזמנה", verbatim):
//   · not calendar.book, or the tenant has no booster module → allow untouched
//   · no booster lead for the sender → allow (non-express calendar is protected)
//   · lookup error → allow (fail-open) + log — never block a real client on
//     a booster outage
//   · lead at awaiting_meeting with no meeting_booked note → allow, with the
//     characterization title: "פגישת אפיון — הזמנה {quote_number}" (from the
//     invite note — F5), falling back to "פגישת אפיון — {name}"
//   · anything else (wrong stage, or a second booking after meeting_booked/F7)
//     → block: the pipeline swaps the reply for BLOCKED_REPLY and relays to Diva
export async function gateCalendarBooking({ business, action, sessionCtx }) {
  if (action?.module !== 'calendar' || action?.name !== 'book') return { allow: true };

  let boosterEnabled = false;
  try {
    const rows = await getEnabledModules(business.id);
    boosterEnabled = rows.some(r => r.module_key === 'booster');
  } catch (e) {
    console.error('[booster-meeting] module lookup failed — gate stays open:', e.message);
    return { allow: true };
  }
  if (!boosterEnabled) return { allow: true };

  const phone = sessionCtx?.session_id;
  let lead;
  try {
    lead = await boosterClient.lookupBoosterLeadByPhone(phone);
  } catch (e) {
    console.error('[booster-meeting] lead lookup failed — allowing the booking (fail-open):', e.message);
    return { allow: true };
  }
  if (!lead) return { allow: true };

  if (lead.status === 'awaiting_meeting') {
    const booked = await getLatestMeetingEvent({ businessId: business.id, type: 'meeting_booked', phone });
    if (!booked) {
      const invite = await getLatestMeetingEvent({ businessId: business.id, type: 'meeting_invite', phone });
      const quoteNumber = invite?.detail?.quote_number ?? null;
      const eventTitleOverride = quoteNumber
        ? `פגישת אפיון — הזמנה ${quoteNumber}`
        : `פגישת אפיון — ${(lead.name ?? '').trim() || 'לקוח אקספרס'}`;
      return {
        allow: true,
        eventTitleOverride,
        expressLead: { leadId: lead.leadId, name: lead.name ?? null, quoteNumber },
      };
    }
  }

  logModuleEvent(business.id, 'booster', 'calendar_book_blocked', {
    phone: normalizeIlPhone(phone), status: lead.status,
  });
  return { allow: false, replyText: BLOCKED_REPLY };
}
