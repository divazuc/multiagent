// Track 1 (funnel v1) — the meeting layer of the express funnel.
//
// Three concerns, one seam-friendly module (see the plan's T1 and
// docs/booster-meeting-scheduling-handoff.md):
//
//   1. Meeting NOTES — meeting_invite / meeting_booked / meeting_requested
//      rows in module_events. No migration: the table already exists
//      (wa-studio/docs/sql/2026-07-24-modules.sql). Note what that schema
//      actually says, because it is a precondition and not a formality:
//      `business_id uuid not null`. A business id is therefore REQUIRED on
//      both sides here — a write without one can only raise a constraint
//      violation, and a read without one would have to drop the tenant filter
//      and could then match another tenant's note for the same phone. Both
//      refuse instead. In production that id is DIVAZ_BUSINESS_ID, which is
//      checked at boot (lib/booster-client.js#warnOnIncompleteBoosterEnv).
//      detail carries {phone, quote_number, slot?}; a read means "the latest
//      row per (type, phone)". The invite note is also the ONLY place the bot
//      knows a lead's quote number from — the booster's by-ref lookup
//      deliberately doesn't return it (F5), so the event-title fallback chain
//      lives here.
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
      // business_id is always filtered — never conditionally. The caller
      // guarantees it is set (see getLatestMeetingEvent).
      const { data, error } = await supabase.from('module_events').select('*')
        .eq('business_id', businessId)
        .eq('module_key', 'booster').eq('event_type', type)
        .eq('detail->>phone', phone)
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .limit(1);
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
  // Hard precondition, not a fallback: module_events.business_id is NOT NULL,
  // so `businessId ?? null` could only ever buy a caught-and-logged constraint
  // violation on every single insert. Skip the write with a log that names the
  // missing deploy step instead of pretending to try.
  if (!businessId) {
    console.error(`[booster-meeting] not recording ${eventType} — DIVAZ_BUSINESS_ID is not set (booster env incomplete)`);
    return false;
  }
  const normalized = normalizeIlPhone(phone);
  if (!normalized) {
    console.error(`[booster-meeting] not recording ${eventType} — unparseable phone:`, phone);
    return false;
  }
  const row = {
    business_id: businessId,
    module_key: 'booster',
    event_type: eventType,
    // Written explicitly (the column defaults to now() anyway) so the note is
    // self-describing and noteCoversOrder can order two notes by recency
    // without a second round-trip.
    created_at: new Date().toISOString(),
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

// A booking made under the calendar module's owner_confirmed mode is a
// REQUEST, not a meeting: the client is told "נאשר לך סופית בהקדם" and Diva
// may yet decline. Recorded under its own type so the two policies can differ:
//   · the GATE treats it like a booking — one characterization meeting per
//     order means one hold on Diva's calendar, pending or not. A client who
//     tries again reaches the block path, which pings Diva through the relay,
//     so a declined request ends with a human rather than with silence.
//   · the booster's 3-day REMINDER is NOT suppressed by it — only a confirmed
//     meeting_booked does that. If the request never becomes a meeting, the
//     reminder is the safety net that re-offers slots.
export const recordMeetingRequested = (args) => recordMeetingEvent('meeting_requested', args);

// The owner tapped "שינוי מועד" on a pending request: the event is gone from
// the calendar, so the request's hold on the order's one meeting must be gone
// too — otherwise the client the owner just asked to re-pick a slot would hit
// the gate's block instead of booking. See cancellationReleases for how the
// gate reads this note.
export const recordMeetingRequestCancelled = (args) => recordMeetingEvent('meeting_request_cancelled', args);

// Latest row per (type, phone), or null — including on ANY failure. Both
// callers want exactly that: the webhook's reminder suppression sends the
// reminder when it cannot know (fail-open), and the gate treats "can't read
// the notes" as "no note" rather than blocking a real client.
export async function getLatestMeetingEvent({ businessId = null, type, phone }) {
  // Every stored row belongs to some tenant (business_id is NOT NULL), so a
  // read without a business id must not simply DROP the filter: it would then
  // match another tenant's note for the same phone and, for instance,
  // suppress a reminder that should have been sent. Refuse rather than widen.
  if (!businessId) {
    console.error(`[booster-meeting] ${type} read skipped — no business id (a read without one would cross tenants)`);
    return null;
  }
  const normalized = normalizeIlPhone(phone);
  if (!normalized) return null;
  try {
    if (db) {
      // A fake may supply latestEvent to mimic the real store's async read
      // (e.g. a PostgREST connection that stalls); otherwise the plain
      // in-memory rows stand in, insertion order for created_at.
      if (typeof db.latestEvent === 'function') return await db.latestEvent({ businessId, type, phone: normalized });
      const rows = db.events.filter(r =>
        r.business_id === businessId &&
        r.module_key === 'booster' && r.event_type === type &&
        r.detail?.phone === normalized);
      return rows.length ? rows[rows.length - 1] : null;
    }
    return await (await realDb()).latestEvent({ businessId, type, phone: normalized });
  } catch (e) {
    console.error('[booster-meeting] latest-event read failed — treating as none:', e.message);
    return null;
  }
}

// ── "Is this note about the order in front of us?" ───────────────────────────
//
// A meeting note only ever means something RELATIVE TO AN ORDER. Asking the
// unscoped question — "is there ANY meeting_booked row for this phone" —
// locks a repeat customer out permanently: a client who booked in August and
// signs a second order in November could never schedule the new order's
// meeting, and that new order's 3-day reminders would be silently killed too.
//
// The webhook writes a fresh meeting_invite per order, so the current order is
// identified by its quote number: carried on the invite note (the gate's
// reference) or on the webhook payload (the reminder's). Rules, in order:
//   · no note at all                → not covered (nothing has happened yet)
//   · no reference to compare to    → covered (conservative: F7 stands)
//   · both carry a quote number     → covered iff they are the SAME order
//   · either quote number missing   → fall back to recency: a note older than
//     the current order's marker belongs to the previous order
export function noteCoversOrder(note, order) {
  if (!note) return false;
  if (!order) return true;
  const noteQuote = quoteOf(note);
  const orderQuote = quoteOf(order);
  if (noteQuote && orderQuote) return noteQuote === orderQuote;
  return !(stampOf(order) > stampOf(note));
}

// Both a note row ({detail:{quote_number}, created_at}) and a raw webhook
// payload ({quote_number}) are accepted as "the order".
const quoteOf = (o) => o?.detail?.quote_number ?? o?.quote_number ?? null;
const stampOf = (o) => Date.parse(o?.created_at ?? '') || 0;

// Does this meeting_request_cancelled note void the pending request's hold?
// Two conditions, both required:
//   · same order — noteCoversOrder's own machinery (quote match, recency
//     fallback), with the REQUEST standing in as "the order"
//   · the cancel is not older than the request. A client who re-picked a slot
//     after a reschedule has a NEWER meeting_requested note, and that new
//     request must hold again — a stale cancel cannot keep releasing forever.
export function cancellationReleases(requested, cancelled) {
  if (!requested || !cancelled) return false;
  if (stampOf(cancelled) < stampOf(requested)) return false;
  return noteCoversOrder(cancelled, requested);
}

// ── Slot offer copy ──────────────────────────────────────────────────────────

import { hebDateDMY } from './heb-date.js';

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
  const lines = [...byDay.entries()].map(([date, times]) => {
    const day = HEB_DAYS[new Date(`${date}T00:00:00`).getDay()]; // NaN index → undefined
    return `- ${day ? `${day} ` : ''}${hebDateDMY(date)}: ${times.join(', ')}`; // dd/mm/yyyy for the client (owner, 2026-08-29)
  });
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
    // The invite note IS the current order (a fresh one per order), so it is
    // both the title source and the yardstick a previous booking is measured
    // against — see noteCoversOrder.
    const [invite, booked, requested, cancelled] = await Promise.all([
      getLatestMeetingEvent({ businessId: business.id, type: 'meeting_invite', phone }),
      getLatestMeetingEvent({ businessId: business.id, type: 'meeting_booked', phone }),
      getLatestMeetingEvent({ businessId: business.id, type: 'meeting_requested', phone }),
      getLatestMeetingEvent({ businessId: business.id, type: 'meeting_request_cancelled', phone }),
    ]);
    // A pending request holds the order's one meeting slot just like a
    // confirmed one does — see recordMeetingRequested for the full policy —
    // UNLESS the owner rescheduled it away (cancellationReleases): the client
    // must then be able to book the replacement slot.
    const requestHolds = noteCoversOrder(requested, invite) && !cancellationReleases(requested, cancelled);
    const held = noteCoversOrder(booked, invite) || requestHolds;
    if (!held) {
      const quoteNumber = invite?.detail?.quote_number ?? null;
      const eventTitleOverride = quoteNumber
        ? `פגישת אפיון — הזמנה ${quoteNumber}`
        : `פגישת אפיון — ${(lead.name ?? '').trim() || 'לקוח אקספרס'}`;
      return {
        allow: true,
        eventTitleOverride,
        // email tolerates both by-ref shapes — the booster is only now adding
        // the field, so an old response simply carries null here.
        expressLead: { leadId: lead.leadId, name: lead.name ?? null, quoteNumber, email: lead.email ?? null },
      };
    }
  }

  logModuleEvent(business.id, 'booster', 'calendar_book_blocked', {
    phone: normalizeIlPhone(phone), status: lead.status,
  });
  return { allow: false, replyText: BLOCKED_REPLY };
}

// ── Blocked-booking handling (T7) ────────────────────────────────────────────

// Relay seam — lazy import like conversation.js: lib/relay pulls in modules a
// unit test must never load.
let relayRaise = null;
export function _setRelayForTest(fn) { relayRaise = fn; }

// A blocked booking REPLACES the model's reply with the fixed line and pings
// Diva through the relay so she can call the client back. The relay is
// best-effort by design: with WHATSAPP_ESCALATION_TEMPLATE unset (F1, today's
// production state) raiseEscalation refuses and the client still gets the
// fixed reply — Diva's ping is her action item, never the client's problem.
export async function handleBlockedBooking({ business, session_id, question, history = null, persona = {} }) {
  try {
    const raise = relayRaise ?? (await import('./relay/index.js')).raiseEscalation;
    await raise({
      business, session_id, question,
      reason: 'express_meeting_guardrail', history, persona,
    });
  } catch (e) {
    console.error('[booster-meeting] block escalation failed — the client still gets the fixed reply:', e.message);
  }
  return BLOCKED_REPLY;
}
