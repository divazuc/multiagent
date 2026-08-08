import express from 'express';
import crypto from 'node:crypto';
import { sendWhatsAppMessage } from '../lib/wa-send.js';
import { boosterMessageFor, toWaNumber } from '../lib/booster-messages.js';
import { formatSlotOffer, recordMeetingInvite, getLatestMeetingEvent } from '../lib/booster-meeting.js';
import { getEnabledModules } from '../lib/modules/engine.js';
import { MODULES } from '../lib/modules/registry.js';

const router = express.Router();

// At-least-once delivery from the booster's outbox → in-memory dedup by
// event_id (bounded). Survives normal operation; a restart may re-send at
// most one 10-minute batch — accepted for v1 (documented in the plan).
// An event_id is only ever remembered once it is either delivered or
// legitimately skipped (malformed/unroutable) — a FAILED send must never be
// remembered, or the booster's outbox would mark it 'sent' while the client
// silently got nothing.
const seen = new Set();
const remember = (id) => { seen.add(id); if (seen.size > 1000) seen.delete(seen.values().next().value); };

// Test seam — production always sends through the real Graph client; tests
// inject a stub so success/failure/timeout can be simulated without a
// network call. Keeps the default wiring (index.js -> this router) untouched.
let sendFn = sendWhatsAppMessage;
export const _setSendForTest = (fn) => { sendFn = fn ?? sendWhatsAppMessage; };

// Same pattern as lib/auth.js's ADMIN_API_KEY check: constant-time compare,
// length pre-checked first because timingSafeEqual throws on a length
// mismatch rather than returning false.
function bearerOk(req) {
  const key = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const expected = process.env.BOT_WEBHOOK_SECRET ?? '';
  try {
    return !!(expected && key.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected)));
  } catch {
    return false; // length mismatch
  }
}

// The booster expects a 2xx within 8s and retries otherwise, and a retry that
// lands before `seen` holds the event_id is a DOUBLE SEND on the client's
// phone. So the handler runs on ONE shared deadline rather than per-step
// timeouts that stack: every optional prefix step (the notes read, the slot
// fetch) is subtracted from what the send has left, never added on top of it.
// 7s leaves ~1s for the response itself to reach the booster inside its 8s
// window.
const REQUEST_BUDGET_MS = 7000;

// Caps for the two prefix steps. Each is also min'd against whatever is left
// of the shared deadline, so neither can ever push the send past the SLA.
const NOTES_READ_TIMEOUT_MS = 400;
const TIMED_OUT = Symbol('booster-webhook-send-timeout');
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── Meeting events (funnel track 1, T2) ──────────────────────────────────────
// send_signed_summary / send_meeting_reminder now open the in-chat scheduling
// flow: real free slots from Diva's calendar module ride the SAME message
// (one send — a second bubble would race the first and read like spam), and a
// meeting_invite note is recorded so the booking gate can title the event
// after the order (F5 — by-ref doesn't return the quote number).
const MEETING_EVENTS = new Set(['send_signed_summary', 'send_meeting_reminder']);

// 2.5s is generous for a freeBusy round-trip, and on ANY miss (timeout,
// error, no calendar module, no slots) the event degrades to today's copy —
// scheduling help is a bonus, delivery is the contract. Whatever it spends
// comes out of the send's share of REQUEST_BUDGET_MS, never on top of it.
const SLOTS_TIMEOUT_MS = 2500;

async function fetchMeetingSlotsReal() {
  const businessId = process.env.DIVAZ_BUSINESS_ID;
  if (!businessId) return null;
  const rows = await getEnabledModules(businessId);
  const row = rows.find(r => r.module_key === 'calendar');
  if (!row) return null;
  // Same gate as the module's own contextProvider: an unconnected calendar
  // (except the network-free fake provider) has no slots to offer.
  if (row.status !== 'connected' && row.settings?.provider !== 'fake') return null;
  return MODULES.calendar._computeCurrentSlots(row);
}
let fetchMeetingSlots = fetchMeetingSlotsReal;
export const _setSlotsFetcherForTest = (fn) => { fetchMeetingSlots = fn ?? fetchMeetingSlotsReal; };

async function slotOfferFor(payload, timeoutMs) {
  try {
    const slots = await withTimeout(fetchMeetingSlots(), timeoutMs);
    if (slots === TIMED_OUT) {
      console.error('[booster-webhook] slot fetch timed out — sending the base copy');
      return null;
    }
    return formatSlotOffer(slots, { quoteNumber: payload?.quote_number });
  } catch (e) {
    console.error('[booster-webhook] slot fetch failed — sending the base copy:', e.message);
    return null;
  }
}

router.post('/booster-webhook', async (req, res) => {
  // One deadline for the whole request — see REQUEST_BUDGET_MS.
  const deadline = Date.now() + REQUEST_BUDGET_MS;
  const remaining = () => Math.max(0, deadline - Date.now());
  const budget = (cap) => Math.min(cap, remaining());

  if (!bearerOk(req)) {
    return res.status(401).json({ ok: false });
  }
  const { event_id, event, payload, lead } = req.body ?? {};
  if (!event_id || !event) return res.status(400).json({ ok: false, error: 'bad_shape' });
  if (seen.has(event_id)) return res.json({ ok: true, deduped: true });

  let text = boosterMessageFor(event, payload, lead);
  const to = toWaNumber(lead?.phone);
  if (!text || !to || to.length < 11) {
    console.warn('[booster-webhook] skipped event', event, event_id, 'to:', to);
    remember(event_id);
    return res.json({ ok: true, skipped: true }); // ack — a malformed event must not retry forever
  }

  // F2 mitigation (T7): the booster can't know a meeting was scheduled (no
  // meeting-scheduled endpoint until v1.1), so its 3-day reminder would nag a
  // client who already booked in chat. A meeting_booked note suppresses the
  // reminder here — acked and remembered like any legitimately-skipped event.
  // getLatestMeetingEvent fails SOFT to null, so an unreadable notes store
  // sends the reminder (fail-open) rather than silently losing it — but
  // "fails soft" only covers a REJECTION. supabase-js has no client-side
  // timeout, so a stalled PostgREST connection would hold this response open
  // indefinitely (and every booster retry would open another one). The read is
  // therefore time-boxed too, a timeout meaning "no note" — the same
  // fail-open direction.
  if (event === 'send_meeting_reminder') {
    const booked = await withTimeout(getLatestMeetingEvent({
      businessId: process.env.DIVAZ_BUSINESS_ID ?? null,
      type: 'meeting_booked',
      phone: lead?.phone,
    }), budget(NOTES_READ_TIMEOUT_MS));
    if (booked === TIMED_OUT) {
      console.error('[booster-webhook] notes read timed out — sending the reminder (fail-open)', event_id);
    } else if (booked) {
      console.log('[booster-webhook] reminder suppressed — meeting already booked', event_id);
      remember(event_id);
      return res.json({ ok: true, skipped: true });
    }
  }

  // Meeting events: append the real slot offer to this same message. Best
  // effort — a null offer (no calendar, no slots, error, timeout) sends the
  // base copy unchanged.
  if (MEETING_EVENTS.has(event)) {
    const offer = await slotOfferFor(payload, budget(SLOTS_TIMEOUT_MS));
    if (offer) text = `${text}\n\n${offer}`;
  }

  // wa-send.js deliberately never rejects (other call sites rely on that
  // never-throw contract), so a try/catch around the call cannot detect
  // failure — it resolves the Graph response on success, and resolves
  // undefined or an {error} body on any failure (missing credentials, a
  // rejected/expired token, a Supabase lookup failure, or Meta bouncing the
  // message). Success must therefore be read from the RESULT shape: Graph's
  // success response is always {messages:[{id, ...}]}. A 24h-messaging-window
  // rejection lands in this same failure path deliberately — a business-
  // initiated reminder/expiry notice Meta bounces must surface in the
  // booster's outbox as failed, not vanish behind a false 200.
  let result;
  try {
    result = await withTimeout(
      sendFn({ to, text, businessId: process.env.DIVAZ_BUSINESS_ID ?? null }),
      remaining(), // whatever the prefix steps left of the shared deadline
    );
  } catch (e) {
    console.error('[booster-webhook] send threw unexpectedly', event_id, e.message);
    result = null;
  }

  const timedOut = result === TIMED_OUT;
  const ok = !timedOut && !!result?.messages?.length;
  if (!ok) {
    console.error('[booster-webhook] send failed', event_id,
      timedOut ? 'timeout' : JSON.stringify(result ?? null));
    return res.status(502).json({ ok: false }); // booster retries (≤5 attempts) — event_id intentionally NOT remembered
  }

  // Delivered — for meeting events, note the invite (phone + quote number) in
  // module_events. Best-effort and non-blocking: the note only feeds the
  // event-title fallback and the gate; losing one must not fail the delivery.
  if (MEETING_EVENTS.has(event)) {
    Promise.resolve(recordMeetingInvite({
      businessId: process.env.DIVAZ_BUSINESS_ID ?? null,
      phone: lead?.phone,
      quoteNumber: payload?.quote_number ?? null,
    })).catch(() => {}); // recordMeetingInvite already logs its own failures
  }

  remember(event_id);
  return res.json({ ok: true });
});

export default router;
