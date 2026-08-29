// server/test/module-action-step.test.js
//
// The reply pipeline's module-action step, tested for what it DOES.
// booster-gate-wiring.test.js could only pin index.js by source text
// (`gateIdx < execIdx`), which passes just as happily with an inverted
// condition — so the behaviour that actually matters is asserted here against
// the extracted lib/module-action-step.js:
//   · a blocked booking produces exactly ONE outbound message — the fixed
//     line — and never reaches the calendar
//   · a meeting note is written exactly once after a booking that really
//     succeeded, and zero times after one that failed
//   · success is read from the module's structured result, never from its copy
//   · a tentative (owner_confirmed) booking is a REQUEST, not a booking
// Real modules throughout (fake calendar provider, in-memory notes store) —
// no network, and obviously fake fixtures: this repo is public.
process.env.MODULE_SECRETS_KEY = Buffer.alloc(32).toString('base64');

import test from 'node:test';
import assert from 'node:assert/strict';

const engine = await import('../lib/modules/engine.js');
const meeting = await import('../lib/booster-meeting.js');
const calendarMod = await import('../lib/modules/calendar/index.js');
const { runModuleActionStep, _setExecutorForTest } = await import('../lib/module-action-step.js');
const { BLOCKED_REPLY } = meeting;

const BIZ = { id: 'b1', name: 'Diva Ost' };
const SESSION = '972521234567';        // the sender's WhatsApp id
const PHONE = '0521234567';            // the same number, booster-side
const MODEL_TEXT = 'בטח, אשריין לך שלישי ב-10';

const HOURS = [{ from: '10:00', to: '14:00' }];
const calSettings = (mode) => ({
  provider: 'fake', mode, duration_min: 30, buffer_min: 0, horizon_days: 7, min_notice_hours: 0,
  weekly: { sun: HOURS, mon: HOURS, tue: HOURS, wed: HOURS, thu: HOURS, fri: HOURS, sat: HOURS },
  overrides: {}, jewish_holidays_closed: false, event_title: 'פגישה — {name}',
});
const calRow = (mode) => ({
  business_id: 'b1', module_key: 'calendar', enabled: true, status: 'connected',
  secrets: {}, settings: calSettings(mode),
});

let created = [];
function seed({ mode = 'autonomous', leadStatus = 'awaiting_meeting' } = {}) {
  created = [];
  calendarMod._setProviderForTest({
    freeBusy: async () => [],
    createEvent: async (_s, ev) => { created.push(ev); return { eventId: 'ev1', htmlLink: '' }; },
  });
  engine._setDbForTest({
    enabledRows: [
      { business_id: 'b1', module_key: 'booster', enabled: true, status: 'connected', secrets: {}, settings: {} },
      calRow(mode),
    ],
    onEvent: () => {},
  });
  const notes = { events: [] };
  meeting._setDbForTest(notes);
  meeting._setBoosterClientForTest({
    lookupBoosterLeadByPhone: async () => ({ leadId: 'l1', name: 'דנה כהן', status: leadStatus }),
  });
  meeting._setRelayForTest(async () => ({ holdingLine: 'x' }));
  return notes;
}

const bookableSlot = async (mode = 'autonomous') => {
  const slots = await calendarMod.default._computeCurrentSlots(calRow(mode));
  return `${slots[0].date}T${slots[0].from}`;
};
const bookAction = (slot) => ({ module: 'calendar', name: 'book', payload: { slot, name: 'דנה' } });
const typed = (notes, type) => notes.events.filter(e => e.event_type === type);

test.afterEach(() => {
  engine._setDbForTest(null);
  meeting._setDbForTest(null);
  meeting._setBoosterClientForTest(null);
  meeting._setRelayForTest(null);
  calendarMod._setProviderForTest(null);
  _setExecutorForTest(null);
});

test('a blocked booking replaces the reply with the fixed line — one message — and never reaches the calendar', async () => {
  const notes = seed({ leadStatus: 'signed' }); // wrong stage → blocked
  const step = await runModuleActionStep({
    business: BIZ, action: bookAction(await bookableSlot()),
    session_id: SESSION, question: 'אפשר לקבוע עוד פגישה מחר?', finalResponse: MODEL_TEXT,
  });

  assert.equal(step.blocked, true);
  assert.equal(step.text, BLOCKED_REPLY,
    'the block REPLACES the model text — one bubble, never the answer with the fixed line stapled under it');
  assert.ok(!step.text.includes(MODEL_TEXT));
  assert.equal(created.length, 0, 'the gate runs BEFORE any side effect — no event on Diva\'s calendar');
  assert.equal(notes.events.length, 0, 'and nothing is noted for a booking that never happened');
});

test('a confirmed booking writes exactly ONE meeting_booked note, carrying the order and the slot', async () => {
  const notes = seed();
  await meeting.recordMeetingInvite({ businessId: 'b1', phone: PHONE, quoteNumber: 'DZ-2026-1042' });
  const slot = await bookableSlot();

  const step = await runModuleActionStep({
    business: BIZ, action: bookAction(slot), session_id: SESSION, finalResponse: MODEL_TEXT,
  });

  assert.deepEqual(step.booking, { ok: true, tentative: false });
  assert.ok(step.text.startsWith(MODEL_TEXT), 'a normal action is appended to the model reply');
  assert.match(step.text, /נקבעה/);
  assert.equal(created[0].title, 'פגישת אפיון — הזמנה DZ-2026-1042',
    'the gate\'s characterization title reached the calendar module');

  const booked = typed(notes, 'meeting_booked');
  assert.equal(booked.length, 1, 'exactly one note — not zero, not two');
  assert.equal(booked[0].detail.quote_number, 'DZ-2026-1042');
  assert.equal(booked[0].detail.slot, slot);
});

test('a failed booking writes no note at all', async () => {
  const notes = seed();
  await meeting.recordMeetingInvite({ businessId: 'b1', phone: PHONE, quoteNumber: 'DZ-1' });

  const step = await runModuleActionStep({
    business: BIZ, action: bookAction('2030-01-01T03:00'), // never on the computed list
    session_id: SESSION, finalResponse: MODEL_TEXT,
  });

  assert.deepEqual(step.booking, { ok: false });
  assert.match(step.text, /לא זמין/, 'the client is told the slot is gone');
  assert.equal(created.length, 0);
  assert.equal(typed(notes, 'meeting_booked').length, 0, 'a failed booking must never lock the client out via F7');
  assert.equal(typed(notes, 'meeting_requested').length, 0);
});

test('success is read from the structured flag, never from the reply copy', async () => {
  const notes = seed();
  await meeting.recordMeetingInvite({ businessId: 'b1', phone: PHONE, quoteNumber: 'DZ-1' });
  const action = bookAction('2026-08-10T10:00');

  // A brand-new failure string. The old heuristic — !includes('נתפס') &&
  // !includes('לא זמין') — would have read this as a successful booking.
  _setExecutorForTest(async () => ({ text: 'היומן לא הגיב כרגע, ננסה שוב', result: { ok: false } }));
  await runModuleActionStep({ business: BIZ, action, session_id: SESSION, finalResponse: MODEL_TEXT });
  assert.equal(typed(notes, 'meeting_booked').length, 0,
    'an unrecognised failure string must not become a booking');

  // And copy that READS like success is not a success claim either — only the
  // structured result is.
  _setExecutorForTest(async () => ({ text: 'הפגישה נקבעה! 🎉', result: null }));
  await runModuleActionStep({ business: BIZ, action, session_id: SESSION, finalResponse: MODEL_TEXT });
  assert.equal(typed(notes, 'meeting_booked').length, 0,
    'no structured result means the module made no claim — neither does the pipeline');
});

test('a tentative owner_confirmed booking is recorded as meeting_requested, never as meeting_booked', async () => {
  const notes = seed({ mode: 'owner_confirmed' });
  await meeting.recordMeetingInvite({ businessId: 'b1', phone: PHONE, quoteNumber: 'DZ-1' });

  const step = await runModuleActionStep({
    business: BIZ, action: bookAction(await bookableSlot('owner_confirmed')),
    session_id: SESSION, finalResponse: MODEL_TEXT,
  });

  assert.deepEqual(step.booking, { ok: true, tentative: true });
  // The double-meaning live bug: the model's "אני מאשרת את הפגישה" used to be
  // stapled above the module's "awaiting approval" copy. The module copy is
  // now the ENTIRE outbound text — nothing above it, nothing below it.
  assert.equal(step.text, 'מעולה! העברתי את המועד לאישור סופי ואחזור אליך ממש בקרוב 🙏 ברגע שהמועד יאושר — יישלח לך זימון למייל.',
    'the tentative reply is ONLY the module copy');
  assert.ok(!step.text.includes(MODEL_TEXT), 'the model\'s own contradicting text must not survive');
  assert.equal(typed(notes, 'meeting_booked').length, 0,
    'a request Diva may yet decline is not a booked meeting — recording it as one locks the client out via F7');
  assert.equal(typed(notes, 'meeting_requested').length, 1);
});

test('a non-calendar action passes the gate untouched and is appended to the model reply', async () => {
  const notes = seed();
  const boosterMod = await import('../lib/modules/booster.js');
  boosterMod._setBoosterClientForTest({
    lookupBoosterLeadByPhone: async () => ({ leadId: 'l1', quoteUrl: 'https://booster.invalid/flow/share/abc' }),
  });
  try {
    const step = await runModuleActionStep({
      business: BIZ, action: { module: 'booster', name: 'resend_quote_link', payload: {} },
      session_id: SESSION, finalResponse: 'רגע, מחפש',
    });
    assert.ok(step.text.startsWith('רגע, מחפש'));
    assert.match(step.text, /flow\/share\/abc/);
    assert.equal(step.blocked, false);
    assert.equal(notes.events.length, 0, 'only a calendar booking is ever noted');
  } finally {
    boosterMod._setBoosterClientForTest(null);
  }
});

test('request_callback REPLACES the reply — the pinned line is sent once, not stapled under a contradicting answer', async () => {
  const notes = seed();
  const boosterMod = await import('../lib/modules/booster.js');
  boosterMod._setRelayForTest(async () => ({ holdingLine: 'x' }));
  try {
    const step = await runModuleActionStep({
      business: BIZ, action: { module: 'booster', name: 'request_callback', payload: {} },
      session_id: SESSION, finalResponse: MODEL_TEXT,
    });
    // The gate replaces; this must too. `${model text}\nדיוה תחזור אליך בהקדם`
    // reads as a promise immediately contradicted.
    assert.equal(step.text, 'דיוה תחזור אליך בהקדם 🙂');
    assert.ok(!step.text.includes('שלישי'), 'the model\'s improvised appointment must not survive');
    assert.equal((step.text.match(/דיוה תחזור אליך בהקדם/g) ?? []).length, 1, 'the pinned line appears exactly once');
    assert.equal(notes.events.length, 0);
  } finally {
    boosterMod._setRelayForTest(null);
  }
});

test('no module action at all leaves the model reply exactly as it was', async () => {
  seed();
  const step = await runModuleActionStep({ business: BIZ, action: null, session_id: SESSION, finalResponse: MODEL_TEXT });
  assert.equal(step.text, MODEL_TEXT);
  assert.equal(step.moduleText, null);
  assert.equal(step.booking, null);
});

// The WhatsApp profile name travels the same route as the phone: from the
// webhook, through sessionCtx, never from the model. create_quote_lead uses it
// to name a lead the customer was never interrogated for.
test('the WhatsApp profile name reaches the module handler on sessionCtx', async () => {
  seed();
  let seenCtx = null;
  _setExecutorForTest(async (_biz, _action, sessionCtx) => {
    seenCtx = sessionCtx;
    return { text: 'ok', result: null };
  });
  try {
    await runModuleActionStep({
      business: BIZ, action: { module: 'booster', name: 'create_quote_lead', payload: { package_id: 'mini' } },
      session_id: SESSION, profile_name: 'דנה כהן', finalResponse: MODEL_TEXT,
    });
    assert.equal(seenCtx.session_id, SESSION);
    assert.equal(seenCtx.profile_name, 'דנה כהן');
  } finally {
    _setExecutorForTest(null);
  }
});

// ── Name injection (the "רק צריכה את שמך המלא" live bug) ─────────────────────
// The signed quote already carries the client's name; a model that omitted it
// from the booking payload must not cost the client another question.

const namelessBook = (slot) => ({ module: 'calendar', name: 'book', payload: { slot } });

test('a book the model sent without a name is completed with the express lead\'s name', async () => {
  const notes = seed();
  await meeting.recordMeetingInvite({ businessId: 'b1', phone: PHONE, quoteNumber: 'DZ-2026-1042' });
  const slot = await bookableSlot();

  const step = await runModuleActionStep({
    business: BIZ, action: namelessBook(slot), session_id: SESSION, finalResponse: MODEL_TEXT,
  });

  assert.deepEqual(step.booking, { ok: true, tentative: false }, 'the booking went through — nobody asked for a name');
  assert.equal(created.length, 1);
  assert.match(created[0].description, /דנה כהן/, 'the event carries the lead\'s real name, injected server-side');
  assert.equal(typed(notes, 'meeting_booked').length, 1);
});

test('the booster placeholder "ליד וואטסאפ" is never treated as a name — the ask-path stands', async () => {
  const notes = seed();
  meeting._setBoosterClientForTest({
    lookupBoosterLeadByPhone: async () => ({ leadId: 'l1', name: 'ליד וואטסאפ', status: 'awaiting_meeting' }),
  });
  const step = await runModuleActionStep({
    business: BIZ, action: namelessBook(await bookableSlot()), session_id: SESSION, finalResponse: MODEL_TEXT,
  });
  assert.equal(created.length, 0, 'no event may be booked under the placeholder');
  assert.equal(step.text, MODEL_TEXT, 'the model\'s own reply (which asked for the name) goes out unchanged');
  assert.equal(typed(notes, 'meeting_booked').length, 0);
});

test('no express lead and no profile name → the old ask-path, unchanged for non-booster clients', async () => {
  const notes = seed();
  meeting._setBoosterClientForTest({ lookupBoosterLeadByPhone: async () => null });
  const step = await runModuleActionStep({
    business: BIZ, action: namelessBook(await bookableSlot()), session_id: SESSION, finalResponse: MODEL_TEXT,
  });
  assert.equal(created.length, 0);
  assert.equal(step.text, MODEL_TEXT);
  assert.equal(notes.events.length, 0);
});

test('the express lead\'s email and quote number reach the approval layer of a tentative booking', async () => {
  seed({ mode: 'owner_confirmed' });
  await meeting.recordMeetingInvite({ businessId: 'b1', phone: PHONE, quoteNumber: 'DZ-2026-1042' });
  meeting._setBoosterClientForTest({
    lookupBoosterLeadByPhone: async () =>
      ({ leadId: 'l1', name: 'דנה כהן', status: 'awaiting_meeting', email: 'dana@example.com' }),
  });
  const approvals = [];
  calendarMod._setOwnerApprovalForTest(async (args) => { approvals.push(args); return 'telegram'; });
  try {
    const slot = await bookableSlot('owner_confirmed');
    const step = await runModuleActionStep({
      business: BIZ, action: namelessBook(slot), session_id: SESSION, finalResponse: MODEL_TEXT,
    });
    assert.deepEqual(step.booking, { ok: true, tentative: true });
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].clientEmail, 'dana@example.com', 'threaded from the by-ref lookup via expressLead');
    assert.equal(approvals[0].quoteNumber, 'DZ-2026-1042');
    assert.equal(approvals[0].name, 'דנה כהן');
  } finally {
    calendarMod._setOwnerApprovalForTest(null);
  }
});

test('an old-shape by-ref response (no email field) books exactly the same, with no email downstream', async () => {
  seed({ mode: 'owner_confirmed' });
  const approvals = [];
  calendarMod._setOwnerApprovalForTest(async (args) => { approvals.push(args); return 'telegram'; });
  try {
    const step = await runModuleActionStep({
      business: BIZ, action: namelessBook(await bookableSlot('owner_confirmed')),
      session_id: SESSION, finalResponse: MODEL_TEXT,
    });
    assert.deepEqual(step.booking, { ok: true, tentative: true });
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].clientEmail, null, 'absence normalizes to null — never undefined surprises, never a throw');
  } finally {
    calendarMod._setOwnerApprovalForTest(null);
  }
});

test('a step with no profile name puts no profile_name on sessionCtx', async () => {
  seed();
  let seenCtx = null;
  _setExecutorForTest(async (_biz, _action, sessionCtx) => { seenCtx = sessionCtx; return { text: 'ok', result: null }; });
  try {
    await runModuleActionStep({
      business: BIZ, action: { module: 'booster', name: 'create_quote_lead', payload: { package_id: 'mini' } },
      session_id: SESSION, finalResponse: MODEL_TEXT,
    });
    assert.equal(seenCtx.profile_name, undefined, 'absent stays absent — the module falls back to the booster default');
  } finally {
    _setExecutorForTest(null);
  }
});

test('index.js threads the profile name from the webhook into the action step', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(src, /const \{ message, session_id, phone_number_id, profile_name \} = normalized\.result/,
    'the pipeline must read profile_name out of the normalized message');
  assert.match(src, /runModuleActionStep\(\{[\s\S]{0,400}?profile_name,/,
    'and hand it to the module-action step, or create_quote_lead can never see it');
});
