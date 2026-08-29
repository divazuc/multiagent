// The reply pipeline's module-action step, lifted out of index.js so it can be
// tested for what it DOES rather than pinned by source-text greps (a grep for
// "the gate is called before the executor" passes just as happily with an
// inverted condition).
//
// Order of business, and why each part is where it is:
//   1. the express one-meeting gate runs BEFORE any side effect — a blocked
//      booking must never reach the calendar
//   2. a block REPLACES the whole reply with the fixed line and relays to Diva;
//      it is never appended to the model's text, which may contradict it
//   3. an allowed express booking carries the characterization title through
//      sessionCtx, and is noted afterwards — but only for what actually
//      happened: a CONFIRMED booking is meeting_booked, a request still
//      awaiting Diva's approval is meeting_requested
//   4. the outbound text is composed here so the caller sends exactly one
//      message
import { executeModuleAction } from './modules/engine.js';
import {
  gateCalendarBooking, handleBlockedBooking,
  recordMeetingBooked, recordMeetingRequested,
} from './booster-meeting.js';
import { realLeadName } from './booster-client.js';

// Test seam — lets a test drive the step with an arbitrary module outcome
// (notably: a failure text nobody has seen before) without inventing a module.
let execute = executeModuleAction;
export function _setExecutorForTest(fn) { execute = fn ?? executeModuleAction; }

/**
 * @returns {{text: string, moduleText: string|null, blocked: boolean, booking: object|null}}
 *   text — the full outbound reply, ready to send as ONE message.
 */
export async function runModuleActionStep({
  business, action, session_id, profile_name = null, question = '', history = null, persona = {},
  finalResponse = '',
}) {
  if (!action) return { text: finalResponse, moduleText: null, blocked: false, booking: null };

  // profile_name is the sender's WhatsApp display name (lib/normalize.js). It
  // travels on sessionCtx for the same reason the phone does — it is known by
  // the CHANNEL, not by the model — and is only set when there is one, so a
  // module reads `sessionCtx.profile_name` as absent rather than as "".
  const sessionCtx = { session_id };
  if (profile_name) sessionCtx.profile_name = profile_name;
  // KNOWN INEFFICIENCY (accepted for v1, noted in review): the gate and
  // executeModuleAction each run their own getEnabledModules query, so an
  // allowed action costs two identical reads. Harmless at this volume; the fix
  // is to thread the loaded rows through rather than to cache them.
  const gate = await gateCalendarBooking({ business, action, sessionCtx });
  if (!gate.allow) {
    const replyText = await handleBlockedBooking({ business, session_id, question, history, persona, replyText: gate.replyText });
    return { text: replyText, moduleText: null, blocked: true, booking: null };
  }

  if (gate.eventTitleOverride) sessionCtx.event_title_override = gate.eventTitleOverride;
  if (gate.reschedule) sessionCtx.reschedule = gate.reschedule; // the confirmed meeting this booking would replace
  // An express lead's identity is already on the signed quote — the model must
  // never have to ask for it again ("רק צריכה את שמך המלא" after the client
  // picked a slot was a live bug). Everything here is server-built: the name
  // comes from the booster lead, never from the model, and the placeholder
  // "ליד וואטסאפ" is filtered out by realLeadName. quote_number/client_email
  // ride along for the approval record a tentative booking will create.
  let effectiveAction = action;
  if (gate.expressLead) {
    const knownName = realLeadName(gate.expressLead.name);
    if (knownName) {
      sessionCtx.known_name = knownName;
      if (action.module === 'calendar' && action.name === 'book' && !action.payload?.name) {
        effectiveAction = { ...action, payload: { ...(action.payload ?? {}), name: knownName } };
      }
    }
    if (gate.expressLead.quoteNumber) sessionCtx.quote_number = gate.expressLead.quoteNumber;
    if (gate.expressLead.email) sessionCtx.client_email = gate.expressLead.email;
  }
  const exec = await execute(business, effectiveAction, sessionCtx);
  const moduleText = exec.text;
  const booking = exec.result ?? null;

  // Read the outcome from the module's STRUCTURED result, never by sniffing
  // its Hebrew copy: the old heuristic covered the three failure strings that
  // happened to exist, so any new one would silently have become "booked" and
  // locked the client out of rebooking via F7. No structured result means the
  // module made no claim — so neither do we.
  if (gate.expressLead && booking?.ok) {
    const note = {
      businessId: business.id,
      phone: session_id,
      quoteNumber: gate.expressLead.quoteNumber,
      slot: action.payload?.slot ?? null,
      eventId: booking.eventId ?? null,
    };
    // Fire-and-forget: both helpers log their own failures and never throw.
    // A tentative booking (the calendar module's DEFAULT owner_confirmed mode)
    // is a REQUEST — "רשמתי בקשה … נאשר לך סופית בהקדם" — not a meeting.
    // Recording it as meeting_booked would suppress the booster's 3-day
    // reminder for a meeting that may never be confirmed.
    if (booking.tentative) recordMeetingRequested(note); else recordMeetingBooked(note);
  }

  // An action may claim the whole reply instead of being appended to it —
  // honoured exactly like a gate block. Pinned copy such as the callback line
  // must not arrive stapled under a model answer that contradicts it
  // ("בטח, אשריין לך שלישי ב-10" + "דיוה תחזור אליך בהקדם 🙂").
  const text = moduleText
    ? (exec.replaceResponse ? moduleText : `${finalResponse}\n${moduleText}`.trim())
    : finalResponse;
  return { text, moduleText, blocked: false, booking };
}
