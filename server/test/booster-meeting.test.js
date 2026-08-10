// server/test/booster-meeting.test.js
//
// Track 1 (funnel v1) T1 — the meeting layer of the express funnel:
//   · meeting notes in module_events (meeting_invite / meeting_booked, no
//     migration — schema verified against wa-studio/docs/sql/2026-07-24-modules.sql)
//   · formatSlotOffer — the slot text appended to the booster's own WhatsApp
//     message (send_signed_summary / send_meeting_reminder)
//   · gateCalendarBooking — the one-characterization-meeting guardrail for
//     express clients (docs/booster-meeting-scheduling-handoff.md §2-3)
//
// Same seam conventions as booster-module.test.js / payment-proof.test.js:
// stubbed booster client + an in-memory module_events store, never a network
// call or a real Supabase row.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.MODULE_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

const meeting = await import('../lib/booster-meeting.js');
const engine = await import('../lib/modules/engine.js');
const {
  recordMeetingInvite, recordMeetingBooked, recordMeetingRequested, recordMeetingRequestCancelled,
  getLatestMeetingEvent,
  formatSlotOffer, gateCalendarBooking, BLOCKED_REPLY,
  _setDbForTest, _setBoosterClientForTest,
} = meeting;

const BIZ = { id: 'b1', name: 'Diva Ost' };

function freshDb() {
  const db = { events: [] };
  _setDbForTest(db);
  return db;
}

function stubClient(overrides = {}) {
  return {
    lookupBoosterLeadByPhone: async () => { throw new Error('lookupBoosterLeadByPhone not stubbed'); },
    ...overrides,
  };
}

// The gate consults the module engine for "is the booster module enabled here"
// — seed it the same way booster-module.test.js does.
function seedEngine({ boosterEnabled = true, businessId = 'b1' } = {}) {
  const engineEvents = [];
  engine._setDbForTest({
    enabledRows: boosterEnabled
      ? [{ business_id: businessId, module_key: 'booster', enabled: true, settings: {}, secrets: {}, status: 'connected' }]
      : [],
    onEvent: (e) => engineEvents.push(e),
  });
  return engineEvents;
}

test.afterEach(() => {
  _setDbForTest(null);
  _setBoosterClientForTest(null);
  engine._setDbForTest(null);
});

// ── notes in module_events ───────────────────────────────────────────────────

test('recordMeetingInvite writes a booster module_events row carrying phone + quote_number', async () => {
  const db = freshDb();
  const ok = await recordMeetingInvite({ businessId: 'b1', phone: '0521234567', quoteNumber: 'DZ-2026-1042' });
  assert.equal(ok, true);
  assert.equal(db.events.length, 1);
  const row = db.events[0];
  assert.equal(row.business_id, 'b1');
  assert.equal(row.module_key, 'booster');
  assert.equal(row.event_type, 'meeting_invite');
  assert.equal(row.detail.phone, '0521234567');
  assert.equal(row.detail.quote_number, 'DZ-2026-1042');
});

test('recordMeetingBooked writes the slot, and getLatestMeetingEvent returns the NEWEST row per (type, phone)', async () => {
  freshDb();
  await recordMeetingBooked({ businessId: 'b1', phone: '0521234567', quoteNumber: 'DZ-1', slot: '2026-08-10T10:00' });
  await recordMeetingBooked({ businessId: 'b1', phone: '0521234567', quoteNumber: 'DZ-2', slot: '2026-08-11T11:00' });
  // a different phone and a different type must never shadow the read
  await recordMeetingBooked({ businessId: 'b1', phone: '0509999999', quoteNumber: 'DZ-3', slot: '2026-08-12T12:00' });
  await recordMeetingInvite({ businessId: 'b1', phone: '0521234567', quoteNumber: 'DZ-4' });

  // phone read WhatsApp-style (972…) must still match the stored 05… form
  const latest = await getLatestMeetingEvent({ businessId: 'b1', type: 'meeting_booked', phone: '972521234567' });
  assert.equal(latest.detail.slot, '2026-08-11T11:00');
  assert.equal(latest.detail.quote_number, 'DZ-2');
});

test('getLatestMeetingEvent fails soft: no match → null, a broken store → null (never throws)', async () => {
  freshDb();
  assert.equal(await getLatestMeetingEvent({ businessId: 'b1', type: 'meeting_booked', phone: '0500000001' }), null);
  // an unparseable phone can never match anything — null, not a throw
  assert.equal(await getLatestMeetingEvent({ businessId: 'b1', type: 'meeting_booked', phone: 'not-a-phone' }), null);
  _setDbForTest({ get events() { throw new Error('store down'); } });
  assert.equal(await getLatestMeetingEvent({ businessId: 'b1', type: 'meeting_booked', phone: '0521234567' }), null);
});

// module_events.business_id is `uuid not null` (wa-studio/docs/sql/2026-07-24-modules.sql:21),
// so a business id is a hard precondition on BOTH sides of the notes store:
// a write without one can only produce a constraint violation, and a read
// without one would have to drop the tenant filter — matching another
// tenant's note for the same phone.

test('recordMeetingEvent without a business id skips the insert entirely and names the missing env var', async () => {
  const db = freshDb();
  const logs = [];
  const realError = console.error;
  console.error = (...a) => logs.push(a.join(' '));
  try {
    assert.equal(await recordMeetingInvite({ businessId: null, phone: '0521234567', quoteNumber: 'DZ-1' }), false);
    assert.equal(await recordMeetingBooked({ phone: '0521234567', quoteNumber: 'DZ-1' }), false);
  } finally {
    console.error = realError;
  }
  assert.equal(db.events.length, 0, 'a NOT NULL business_id cannot be satisfied — no doomed insert is attempted');
  assert.equal(logs.length, 2);
  assert.ok(logs.every(l => l.includes('DIVAZ_BUSINESS_ID')),
    'the log must name the missed deploy step, not just "could not record"');
});

test('getLatestMeetingEvent refuses a read with no business id rather than widening it across tenants', async () => {
  const db = freshDb();
  await recordMeetingBooked({ businessId: 'b1', phone: '0521234567', quoteNumber: 'DZ-1', slot: '2026-08-10T10:00' });
  assert.equal(db.events.length, 1, 'the row itself is stored normally');
  assert.equal(await getLatestMeetingEvent({ type: 'meeting_booked', phone: '0521234567' }), null,
    'no business id → no read at all, never a tenant-wide one');
  assert.equal(await getLatestMeetingEvent({ businessId: null, type: 'meeting_booked', phone: '0521234567' }), null);
});

test('two tenants, one phone: a read never crosses into the other tenant', async () => {
  freshDb();
  await recordMeetingBooked({ businessId: 'tenant-a', phone: '0521234567', quoteNumber: 'DZ-A', slot: '2026-08-10T10:00' });
  const mine = await getLatestMeetingEvent({ businessId: 'tenant-a', type: 'meeting_booked', phone: '0521234567' });
  assert.equal(mine.detail.quote_number, 'DZ-A');
  const theirs = await getLatestMeetingEvent({ businessId: 'tenant-b', type: 'meeting_booked', phone: '0521234567' });
  assert.equal(theirs, null,
    "tenant B must not see tenant A's booking — it would suppress a reminder that should have been sent");
});

// ── formatSlotOffer ──────────────────────────────────────────────────────────

const SLOTS = [
  { date: '2026-08-10', from: '10:00', to: '10:30' },
  { date: '2026-08-10', from: '10:30', to: '11:00' },
  { date: '2026-08-11', from: '12:00', to: '12:30' },
];

test('formatSlotOffer lists real slots grouped by day and carries the quote number verbatim', () => {
  const text = formatSlotOffer(SLOTS, { quoteNumber: 'DZ-2026-1042' });
  assert.ok(text && text.length > 0);
  assert.match(text, /DZ-2026-1042/, 'the quote number is interpolated verbatim');
  assert.match(text, /2026-08-10.*10:00, 10:30/, 'same-day slots are grouped on one line');
  assert.match(text, /2026-08-11.*12:00/);
  assert.match(text, /פגישת האפיון/, 'names the characterization meeting');
  // a payload with no quote number still produces a usable offer
  const noQuote = formatSlotOffer(SLOTS, {});
  assert.ok(noQuote && noQuote.length > 0);
  assert.doesNotMatch(noQuote, /null|undefined/);
});

test("formatSlotOffer returns null when there are no slots so the caller keeps today's copy", () => {
  assert.equal(formatSlotOffer([], { quoteNumber: 'DZ-1' }), null);
  assert.equal(formatSlotOffer(null, { quoteNumber: 'DZ-1' }), null);
  assert.equal(formatSlotOffer(undefined, {}), null);
});

test('formatSlotOffer never prints "undefined" for a date it cannot name', () => {
  // getDay() on an unparseable date is NaN, and HEB_DAYS[NaN] is undefined —
  // which would have gone out to the client as literal "undefined 2026-13-45".
  const text = formatSlotOffer([{ date: '2026-13-45', from: '10:00', to: '10:30' }], { quoteNumber: 'DZ-1' });
  assert.ok(text);
  assert.doesNotMatch(text, /undefined/);
  assert.match(text, /2026-13-45: 10:00/, 'the slot itself is still offered');
});

test('formatSlotOffer never prints a price or a ₪ sign', () => {
  const text = formatSlotOffer(SLOTS, { quoteNumber: 'DZ-2026-1042' });
  assert.doesNotMatch(text, /₪/, 'the bot never prints prices of its own');
  assert.doesNotMatch(text, /תשלום/, 'the meeting offer never talks about payment');
});

// ── gateCalendarBooking ──────────────────────────────────────────────────────

const bookAction = { module: 'calendar', name: 'book', payload: { slot: '2026-08-10T10:00', name: 'דנה' } };
const SESSION = { session_id: '972521234567' };

test('gate: a non-calendar.book action (and a business without the booster module) passes without any lead lookup', async () => {
  freshDb();
  seedEngine();
  let lookedUp = false;
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => { lookedUp = true; return null; },
  }));

  const other = await gateCalendarBooking({ business: BIZ, action: { module: 'booster', name: 'resend_quote_link', payload: {} }, sessionCtx: SESSION });
  assert.deepEqual(other, { allow: true });
  assert.equal(lookedUp, false, 'non-book actions must never trigger a booster lookup');

  seedEngine({ boosterEnabled: false });
  const noModule = await gateCalendarBooking({ business: BIZ, action: bookAction, sessionCtx: SESSION });
  assert.deepEqual(noModule, { allow: true });
  assert.equal(lookedUp, false, 'a tenant without the booster module keeps its calendar untouched');
});

test('gate: no booster lead for the sender → allowed untouched (non-express calendar is protected)', async () => {
  freshDb();
  seedEngine();
  _setBoosterClientForTest(stubClient({ lookupBoosterLeadByPhone: async () => null }));
  const r = await gateCalendarBooking({ business: BIZ, action: bookAction, sessionCtx: SESSION });
  assert.equal(r.allow, true);
  assert.equal(r.eventTitleOverride, undefined, 'no lead → no title override');
});

test('gate: lead lookup failure → fail-open allow + log, never a block', async () => {
  freshDb();
  seedEngine();
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => { throw new Error('booster unreachable'); },
  }));
  const r = await gateCalendarBooking({ business: BIZ, action: bookAction, sessionCtx: SESSION });
  assert.equal(r.allow, true, 'a lookup error must never block a real booking (fail-open)');
  assert.equal(r.eventTitleOverride, undefined);
});

test('gate: awaiting_meeting lead with no meeting_booked → allowed with the characterization title (quote number, fallback to the lead name)', async () => {
  freshDb();
  seedEngine();
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => ({ leadId: 'l1', name: 'דנה כהן', status: 'awaiting_meeting' }),
  }));

  // the invite note (recorded when the booster's signed-summary was delivered)
  // is what carries the quote number — by-ref deliberately doesn't (F5)
  await recordMeetingInvite({ businessId: 'b1', phone: '0521234567', quoteNumber: 'DZ-2026-1042' });
  const withQuote = await gateCalendarBooking({ business: BIZ, action: bookAction, sessionCtx: SESSION });
  assert.equal(withQuote.allow, true);
  assert.equal(withQuote.eventTitleOverride, 'פגישת אפיון — הזמנה DZ-2026-1042');
  assert.equal(withQuote.expressLead.leadId, 'l1');
  assert.equal(withQuote.expressLead.quoteNumber, 'DZ-2026-1042');

  // no invite note on record → fall back to the lead's name
  freshDb();
  const withName = await gateCalendarBooking({ business: BIZ, action: bookAction, sessionCtx: SESSION });
  assert.equal(withName.allow, true);
  assert.equal(withName.eventTitleOverride, 'פגישת אפיון — דנה כהן');
});

// "Already booked" has to mean "already booked FOR THIS ORDER". Asking only
// "is there ANY meeting_booked row for this phone" locks a repeat customer out
// permanently — sign a second order in November and the August booking still
// blocks it. The webhook writes a fresh meeting_invite per order, so that note
// is what says which order is current.
test('gate: a repeat customer\'s SECOND order is bookable — a fresh invite supersedes the previous order\'s booking', async () => {
  freshDb();
  seedEngine();
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => ({ leadId: 'l1', name: 'דנה כהן', status: 'awaiting_meeting' }),
  }));

  // August, order DZ-1: invited, then booked.
  await recordMeetingInvite({ businessId: 'b1', phone: '0521234567', quoteNumber: 'DZ-1' });
  await recordMeetingBooked({ businessId: 'b1', phone: '0521234567', quoteNumber: 'DZ-1', slot: '2026-08-10T10:00' });
  const sameOrder = await gateCalendarBooking({ business: BIZ, action: bookAction, sessionCtx: SESSION });
  assert.equal(sameOrder.allow, false, 'F7 preserved: the SAME order still gets exactly one meeting');
  assert.equal(sameOrder.replyText, BLOCKED_REPLY);

  // November, order DZ-2: the webhook recorded a fresh invite for the new order.
  await recordMeetingInvite({ businessId: 'b1', phone: '0521234567', quoteNumber: 'DZ-2' });
  const newOrder = await gateCalendarBooking({ business: BIZ, action: bookAction, sessionCtx: SESSION });
  assert.equal(newOrder.allow, true, 'a returning client must not be locked out of their new order\'s meeting');
  assert.equal(newOrder.eventTitleOverride, 'פגישת אפיון — הזמנה DZ-2');
  assert.equal(newOrder.expressLead.quoteNumber, 'DZ-2');
});

test('gate: with no quote number to compare, the booking is ordered against the invite by recency', async () => {
  const db = freshDb();
  seedEngine();
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => ({ leadId: 'l1', name: 'דנה כהן', status: 'awaiting_meeting' }),
  }));
  // A booking made when no invite was on record carries no quote number (the
  // gate fell back to the lead's name), so only recency can order the two.
  const note = (event_type, created_at) => ({
    business_id: 'b1', module_key: 'booster', event_type, created_at,
    detail: { phone: '0521234567', quote_number: null },
  });
  db.events.push(note('meeting_booked', '2026-08-01T09:00:00.000Z'));
  db.events.push(note('meeting_invite', '2026-11-01T09:00:00.000Z'));
  const newOrder = await gateCalendarBooking({ business: BIZ, action: bookAction, sessionCtx: SESSION });
  assert.equal(newOrder.allow, true, 'an invite NEWER than the booking means a new order started');

  db.events.push(note('meeting_booked', '2026-11-02T09:00:00.000Z'));
  const sameOrder = await gateCalendarBooking({ business: BIZ, action: bookAction, sessionCtx: SESSION });
  assert.equal(sameOrder.allow, false, 'a booking made AFTER the latest invite is the current order — still blocked');
});

// Policy for a booking still awaiting Diva's approval (the calendar module's
// DEFAULT owner_confirmed mode): it holds the order's one meeting slot exactly
// like a confirmed booking does — a second attempt would put a second pending
// hold on her calendar — but it does NOT suppress the booster's 3-day
// reminder (asserted in booster-gate-wiring.test.js), so a request that never
// gets confirmed still ends with slots being re-offered.
test('gate: a pending meeting_requested holds the order\'s one meeting, and a new order clears it', async () => {
  freshDb();
  seedEngine();
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => ({ leadId: 'l1', name: 'דנה כהן', status: 'awaiting_meeting' }),
  }));
  await recordMeetingInvite({ businessId: 'b1', phone: '0521234567', quoteNumber: 'DZ-1' });
  await recordMeetingRequested({ businessId: 'b1', phone: '0521234567', quoteNumber: 'DZ-1', slot: '2026-08-10T10:00' });

  const second = await gateCalendarBooking({ business: BIZ, action: bookAction, sessionCtx: SESSION });
  assert.equal(second.allow, false, 'one characterization meeting per order, pending or confirmed');
  assert.equal(second.replyText, BLOCKED_REPLY);

  await recordMeetingInvite({ businessId: 'b1', phone: '0521234567', quoteNumber: 'DZ-2' });
  const nextOrder = await gateCalendarBooking({ business: BIZ, action: bookAction, sessionCtx: SESSION });
  assert.equal(nextOrder.allow, true, 'a pending request scopes to its own order too');
});

// The reschedule half of the Telegram approval flow: the owner tapped
// "שינוי מועד", the tentative event was deleted, and the client is being
// asked to re-pick a slot in chat — so the pending request's hold MUST be
// gone, or the re-pick lands on the gate's block instead of on the calendar.
test('gate: a meeting_request_cancelled newer than the pending request releases the hold — the re-pick books', async () => {
  freshDb();
  seedEngine();
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => ({ leadId: 'l1', name: 'דנה כהן', status: 'awaiting_meeting' }),
  }));
  await recordMeetingInvite({ businessId: 'b1', phone: '0521234567', quoteNumber: 'DZ-1' });
  await recordMeetingRequested({ businessId: 'b1', phone: '0521234567', quoteNumber: 'DZ-1', slot: '2026-08-12T10:00' });

  const whilePending = await gateCalendarBooking({ business: BIZ, action: bookAction, sessionCtx: SESSION });
  assert.equal(whilePending.allow, false, 'sanity: the pending request holds before the reschedule');

  await recordMeetingRequestCancelled({ businessId: 'b1', phone: '0521234567', quoteNumber: 'DZ-1', slot: '2026-08-12T10:00' });
  const afterCancel = await gateCalendarBooking({ business: BIZ, action: bookAction, sessionCtx: SESSION });
  assert.equal(afterCancel.allow, true, 'the owner released this slot — the client must be able to re-book');
  assert.equal(afterCancel.eventTitleOverride, 'פגישת אפיון — הזמנה DZ-1');
});

test('gate: a request made AFTER the cancel holds again — a stale cancel cannot keep releasing forever', async () => {
  const db = freshDb();
  seedEngine();
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => ({ leadId: 'l1', name: 'דנה כהן', status: 'awaiting_meeting' }),
  }));
  // Explicit timestamps: request → cancel → NEW request (the client re-picked).
  const note = (event_type, created_at, slot) => ({
    business_id: 'b1', module_key: 'booster', event_type, created_at,
    detail: { phone: '0521234567', quote_number: 'DZ-1', ...(slot ? { slot } : {}) },
  });
  db.events.push(note('meeting_invite', '2026-08-10T08:00:00.000Z'));
  db.events.push(note('meeting_requested', '2026-08-10T09:00:00.000Z', '2026-08-12T10:00'));
  db.events.push(note('meeting_request_cancelled', '2026-08-10T10:00:00.000Z', '2026-08-12T10:00'));
  db.events.push(note('meeting_requested', '2026-08-10T11:00:00.000Z', '2026-08-13T11:00'));

  const r = await gateCalendarBooking({ business: BIZ, action: bookAction, sessionCtx: SESSION });
  assert.equal(r.allow, false, 'the re-picked slot is a live pending request — one meeting per order still stands');
  assert.equal(r.replyText, BLOCKED_REPLY);
});

test('gate: a cancel scoped to the PREVIOUS order does not release the new order\'s pending request', async () => {
  const db = freshDb();
  seedEngine();
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => ({ leadId: 'l1', name: 'דנה כהן', status: 'awaiting_meeting' }),
  }));
  const note = (event_type, created_at, quote) => ({
    business_id: 'b1', module_key: 'booster', event_type, created_at,
    detail: { phone: '0521234567', quote_number: quote },
  });
  // Order DZ-2 has a live pending request; the only cancel on record belongs
  // to old order DZ-1 (even though it is NEWER in time).
  db.events.push(note('meeting_invite', '2026-11-01T08:00:00.000Z', 'DZ-2'));
  db.events.push(note('meeting_requested', '2026-11-01T09:00:00.000Z', 'DZ-2'));
  db.events.push(note('meeting_request_cancelled', '2026-11-01T10:00:00.000Z', 'DZ-1'));

  const r = await gateCalendarBooking({ business: BIZ, action: bookAction, sessionCtx: SESSION });
  assert.equal(r.allow, false, 'a different order\'s cancel is not this order\'s release');
});

test('gate: a cancel never releases a CONFIRMED meeting_booked — only the pending request', async () => {
  freshDb();
  seedEngine();
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => ({ leadId: 'l1', name: 'דנה כהן', status: 'awaiting_meeting' }),
  }));
  await recordMeetingInvite({ businessId: 'b1', phone: '0521234567', quoteNumber: 'DZ-1' });
  await recordMeetingBooked({ businessId: 'b1', phone: '0521234567', quoteNumber: 'DZ-1', slot: '2026-08-12T10:00' });
  await recordMeetingRequestCancelled({ businessId: 'b1', phone: '0521234567', quoteNumber: 'DZ-1', slot: '2026-08-12T10:00' });

  const r = await gateCalendarBooking({ business: BIZ, action: bookAction, sessionCtx: SESSION });
  assert.equal(r.allow, false, 'F7: an approved meeting stays exactly one per order');
});

test('gate: any other status — and a second booking after meeting_booked — is blocked with the exact fixed reply', async () => {
  freshDb();
  const engineEvents = seedEngine();
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => ({ leadId: 'l1', name: 'דנה כהן', status: 'signed' }),
  }));
  const wrongStage = await gateCalendarBooking({ business: BIZ, action: bookAction, sessionCtx: SESSION });
  assert.equal(wrongStage.allow, false);
  assert.equal(wrongStage.replyText, 'דיוה תחזור אליך בהקדם 🙂');
  assert.equal(wrongStage.replyText, BLOCKED_REPLY);
  assert.ok(engineEvents.some(e => e.event_type === 'calendar_book_blocked'),
    'a block must be visible in module_events');

  // F7: even at awaiting_meeting, a SECOND booking (meeting_booked on record) is blocked
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => ({ leadId: 'l1', name: 'דנה כהן', status: 'awaiting_meeting' }),
  }));
  await recordMeetingBooked({ businessId: 'b1', phone: '0521234567', quoteNumber: 'DZ-1', slot: '2026-08-10T10:00' });
  const second = await gateCalendarBooking({ business: BIZ, action: bookAction, sessionCtx: SESSION });
  assert.equal(second.allow, false);
  assert.equal(second.replyText, BLOCKED_REPLY);
});
