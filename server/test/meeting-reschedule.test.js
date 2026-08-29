process.env.SUPABASE_URL ??= 'http://supabase.invalid';
process.env.SUPABASE_SERVICE_KEY ??= 'stub-service-key';
process.env.MODULE_SECRETS_KEY ??= Buffer.alloc(32).toString('base64');

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const meeting = await import('../lib/booster-meeting.js');
const engine = await import('../lib/modules/engine.js');
const calendarMod = await import('../lib/modules/calendar/index.js');
const calendar = calendarMod.default;
const { runModuleActionStep } = await import('../lib/module-action-step.js');
const approval = await import('../lib/meeting-approval.js');
const { default: meetingRouter, _setSendForTest } = await import('../routes/meeting-approval.js');
const boosterMod = await import('../lib/modules/booster.js');
const booster = boosterMod.default;

// Owner, 2026-08-29 (E2E): a client with a confirmed meeting who asks for another
// time is not a blocked second booking — it is a RESCHEDULE, and it runs the
// exact same road as the first booking: the bot names the existing meeting and
// offers to change it, proposes real slots, the pick goes to Diva for approval
// ("מעולה! העברתי את המועד לדיוה לאישור סופי…"), and only her approval books
// the new slot — at which point the old event leaves the calendar. A request
// still awaiting approval keeps blocking a further one.

const BIZ = { id: 'b1', name: 'Diva Ost' };
const SESSION = '972521234567';
const PHONE = '0521234567';
const OLD_SLOT = '2026-09-01T14:15';
const HOURS = [{ from: '10:00', to: '14:00' }];
const calSettings = (mode) => ({
  provider: 'fake', mode, duration_min: 30, buffer_min: 0, horizon_days: 7, min_notice_hours: 0,
  weekly: { sun: HOURS, mon: HOURS, tue: HOURS, wed: HOURS, thu: HOURS, fri: HOURS, sat: HOURS },
  overrides: {}, jewish_holidays_closed: false, event_title: 'פגישה — {name}', owner_display_name: 'דיוה',
});
const calRow = (mode, business_id = 'b1') => ({ business_id, module_key: 'calendar', enabled: true, status: 'connected', secrets: {}, settings: calSettings(mode) });
const bookAction = (slot) => ({ module: 'calendar', name: 'book', payload: { slot } });
const bookableSlot = async (mode) => { const s = await calendar._computeCurrentSlots(calRow(mode)); return `${s[0].date}T${s[0].from}`; };

let provider = { created: [], deleted: [], patched: [] };
function seedProvider() {
  provider = { created: [], deleted: [], patched: [] };
  calendarMod._setProviderForTest({
    freeBusy: async () => [],
    createEvent: async (_s, ev) => { provider.created.push(ev); return { eventId: 'ev-new', htmlLink: '' }; },
    getEvent: async (_s, id) => ({ eventId: id, title: '⏳ ממתין לאישור: פגישת אפיון — הזמנה DZ-1', attendees: [] }),
    patchEvent: async (_s, id, patch, opts) => { provider.patched.push({ id, patch, opts }); },
    deleteEvent: async (_s, id) => { provider.deleted.push(id); },
  });
}
function seed({ mode = 'owner_confirmed' } = {}) {
  seedProvider();
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
    lookupBoosterLeadByPhone: async () => ({ leadId: 'l1', name: 'דנה כהן', status: 'awaiting_meeting', email: 'dana@example.com' }),
  });
  meeting._setRelayForTest(async () => ({ holdingLine: 'x' }));
  return notes;
}
const TG_ENV = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'PUBLIC_BASE_URL'];
const savedEnv = {};
test.beforeEach(() => { for (const k of TG_ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; } });
test.afterEach(() => {
  for (const k of TG_ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  meeting._setDbForTest(null); meeting._setBoosterClientForTest(null); meeting._setRelayForTest(null);
  engine._setDbForTest(null); calendarMod._setProviderForTest(null); calendarMod._setOwnerApprovalForTest(null);
  approval._setDbForTest(null); approval._setTelegramFetchForTest(null); approval._setWaSendForTest(null);
  _setSendForTest(null); boosterMod._setBoosterClientForTest(null); boosterMod._clearStatusCacheForTest();
});

test('recordMeetingBooked keeps the calendar eventId on the note — the handle a reschedule needs later', async () => {
  const notes = seed();
  await meeting.recordMeetingBooked({ businessId: 'b1', phone: PHONE, quoteNumber: 'DZ-1', slot: OLD_SLOT, eventId: 'ev-old' });
  assert.equal(notes.events[0].detail.eventId, 'ev-old');
  await meeting.recordMeetingBooked({ businessId: 'b1', phone: PHONE, quoteNumber: 'DZ-1', slot: OLD_SLOT });
  assert.equal('eventId' in notes.events[1].detail, false, 'absent, never null-stringed');
});

test('gate: a CONFIRMED meeting no longer blocks — the booking is allowed as a reschedule of that event', async () => {
  seed();
  await meeting.recordMeetingInvite({ businessId: 'b1', phone: PHONE, quoteNumber: 'DZ-1' });
  await meeting.recordMeetingBooked({ businessId: 'b1', phone: PHONE, quoteNumber: 'DZ-1', slot: OLD_SLOT, eventId: 'ev-old' });
  const gate = await meeting.gateCalendarBooking({ business: BIZ, action: bookAction('2026-09-02T11:00'), sessionCtx: { session_id: SESSION } });
  assert.equal(gate.allow, true);
  assert.deepEqual(gate.reschedule, { previousEventId: 'ev-old', previousSlot: OLD_SLOT });
  assert.equal(gate.eventTitleOverride, 'פגישת אפיון — הזמנה DZ-1');
  assert.equal(gate.expressLead.quoteNumber, 'DZ-1');
});

test('gate: a request still awaiting approval keeps blocking, and says so with the slot', async () => {
  seed();
  await meeting.recordMeetingInvite({ businessId: 'b1', phone: PHONE, quoteNumber: 'DZ-1' });
  await meeting.recordMeetingRequested({ businessId: 'b1', phone: PHONE, quoteNumber: 'DZ-1', slot: OLD_SLOT });
  const gate = await meeting.gateCalendarBooking({ business: BIZ, action: bookAction('2026-09-02T11:00'), sessionCtx: { session_id: SESSION } });
  assert.equal(gate.allow, false);
  assert.match(gate.replyText, /ממתין לאישור של דיוה/);
  assert.match(gate.replyText, /01\/09\/2026 בשעה 14:15/);
});

test('step (owner_confirmed): a reschedule is a REQUEST like the first booking — tentative text, approval carries what it replaces', async () => {
  const notes = seed({ mode: 'owner_confirmed' });
  await meeting.recordMeetingInvite({ businessId: 'b1', phone: PHONE, quoteNumber: 'DZ-1' });
  await meeting.recordMeetingBooked({ businessId: 'b1', phone: PHONE, quoteNumber: 'DZ-1', slot: OLD_SLOT, eventId: 'ev-old' });
  const approvals = [];
  calendarMod._setOwnerApprovalForTest(async (args) => { approvals.push(args); return 'telegram'; });
  const slot = await bookableSlot('owner_confirmed');
  const step = await runModuleActionStep({ business: BIZ, action: bookAction(slot), session_id: SESSION, finalResponse: 'אני מאשרת את הפגישה' });
  assert.equal(step.blocked, false);
  assert.equal(step.booking?.tentative, true);
  assert.match(step.text, /העברתי את המועד לדיוה לאישור סופי/, 'the very same wording as a first booking');
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].replacesEventId, 'ev-old');
  assert.equal(approvals[0].replacesSlot, OLD_SLOT);
  assert.equal(approvals[0].name, 'דנה כהן', 'the known name, never asked again');
  assert.equal(provider.deleted.length, 0, 'nothing leaves the calendar before Diva approves');
  const requested = notes.events.filter(e => e.event_type === 'meeting_requested');
  assert.equal(requested.length, 1);
  assert.equal(requested[0].detail.slot, slot);
});

test('calendar handler (autonomous): a reschedule books the new slot, drops the old event, and says the meeting MOVED', async () => {
  seed({ mode: 'autonomous' });
  const slot = await bookableSlot('autonomous');
  const r = await calendar.actions.book.handler(BIZ, calRow('autonomous'), { slot, name: 'דנה' },
    { session_id: SESSION, reschedule: { previousEventId: 'ev-old', previousSlot: OLD_SLOT } });
  assert.equal(r.result.ok, true);
  assert.equal(r.result.eventId, 'ev-new', 'the new event id rides on the result so the note can keep it');
  assert.deepEqual(provider.deleted, ['ev-old']);
  assert.match(r.confirmationText, /הפגישה הוזזה/);
  assert.match(r.confirmationText, /\d{2}\/\d{2}\/\d{4} בשעה \d{2}:\d{2}/);
});

test('approval record + Telegram: a reschedule request stores what it replaces and tells Diva it is a change of time', async () => {
  const approvals = { events: [] };
  approval._setDbForTest(approvals);
  process.env.TELEGRAM_BOT_TOKEN = 'tg-stub-token'; process.env.TELEGRAM_CHAT_ID = '1'; process.env.PUBLIC_BASE_URL = 'https://bot.example';
  const tg = [];
  approval._setTelegramFetchForTest(async (url, init) => { tg.push(JSON.parse(init.body)); return { ok: true }; });
  approval._setWaSendForTest(async () => {});
  const via = await approval.requestOwnerApproval({
    business: BIZ, calendarRowId: null, ownerNotifyPhone: null, eventId: 'ev-new', phone: SESSION, name: 'דנה כהן',
    slot: '2026-09-02T11:00', quoteNumber: 'DZ-1', clientEmail: 'dana@example.com',
    replacesEventId: 'ev-old', replacesSlot: OLD_SLOT,
  });
  assert.equal(via, 'telegram');
  assert.equal(approvals.events[0].detail.replaces_event_id, 'ev-old');
  assert.equal(approvals.events[0].detail.replaces_slot, OLD_SLOT);
  const text = tg[0].text;
  assert.match(text, /שינוי מועד/);
  assert.match(text, /01\/09\/2026 בשעה 14:15/, 'the meeting being replaced, dd/mm/yyyy');
  assert.match(text, /02\/09\/2026 בשעה 11:00/, 'the requested slot, dd/mm/yyyy');
});

test('approve route: approving a reschedule confirms the new event, deletes the old one, tells the client it MOVED, and records the booking with its eventId', async () => {
  const notes = seed();
  const approvals = { events: [] };
  approval._setDbForTest(approvals);
  engine._setDbForTest({ enabledRows: [calRow('owner_confirmed', 'biz-r')], onEvent: () => {} });
  const token = await approval.createMeetingApproval({
    businessId: 'biz-r', eventId: 'ev-new', calendarRowId: null, phone: SESSION, name: 'דנה כהן',
    slot: '2026-09-02T11:00', quoteNumber: 'DZ-1', clientEmail: 'dana@example.com',
    replacesEventId: 'ev-old', replacesSlot: OLD_SLOT,
  });
  const sent = [];
  _setSendForTest(async (m) => { sent.push(m); });
  const app = express(); app.use(meetingRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/meeting/${token}/approve`, { method: 'POST' });
    assert.equal(res.status, 200);
  } finally { server.close(); }
  assert.deepEqual(provider.deleted, ['ev-old'], 'the replaced meeting leaves the calendar on approval');
  assert.ok(provider.patched.some(p => p.id === 'ev-new' && p.opts?.sendUpdates === 'all'), 'the new event is confirmed and the invite goes out');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /הפגישה הוזזה/);
  assert.match(sent[0].text, /02\/09\/2026 בשעה 11:00/);
  assert.doesNotMatch(sent[0].text, /2026-09-02/);
  const booked = notes.events.filter(e => e.event_type === 'meeting_booked');
  assert.equal(booked.length, 1);
  assert.equal(booked[0].detail.eventId, 'ev-new');
  assert.equal(booked[0].detail.slot, '2026-09-02T11:00');
});

test('approve route: a first booking still says "אושרה", now with a dd/mm/yyyy date', async () => {
  const notes = seed();
  const approvals = { events: [] };
  approval._setDbForTest(approvals);
  engine._setDbForTest({ enabledRows: [calRow('owner_confirmed', 'biz-f')], onEvent: () => {} });
  const token = await approval.createMeetingApproval({
    businessId: 'biz-f', eventId: 'ev-new', calendarRowId: null, phone: SESSION, name: 'דנה כהן',
    slot: '2026-09-02T11:00', quoteNumber: 'DZ-1', clientEmail: 'dana@example.com',
  });
  const sent = [];
  _setSendForTest(async (m) => { sent.push(m); });
  const app = express(); app.use(meetingRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const { port } = server.address();
    await fetch(`http://127.0.0.1:${port}/meeting/${token}/approve`, { method: 'POST' });
  } finally { server.close(); }
  assert.equal(provider.deleted.length, 0);
  assert.match(sent[0].text, /הפגישה אושרה/);
  assert.match(sent[0].text, /02\/09\/2026 בשעה 11:00/);
  assert.equal(notes.events.find(e => e.event_type === 'meeting_booked').detail.eventId, 'ev-new');
});

test('booster context: with a confirmed meeting the model is told to name it and offer a change — through approval, never as a done deal', async () => {
  seed();
  await meeting.recordMeetingInvite({ businessId: 'b1', phone: PHONE, quoteNumber: 'DZ-1' });
  await meeting.recordMeetingBooked({ businessId: 'b1', phone: PHONE, quoteNumber: 'DZ-1', slot: OLD_SLOT, eventId: 'ev-old' });
  boosterMod._setBoosterClientForTest({
    lookupBoosterLeadByPhone: async () => ({ leadId: 'l1', name: 'דנה כהן', status: 'awaiting_meeting' }),
  });
  const ROW = { business_id: 'b1', module_key: 'booster', enabled: true, status: 'connected', secrets: {}, settings: {} };
  const ctx = await booster.contextProvider(BIZ, ROW, { session_id: SESSION });
  assert.match(ctx, /פגישה קבועה/);
  assert.match(ctx, /01\/09\/2026 בשעה 14:15/);
  assert.match(ctx, /להחליף/);
  assert.match(ctx, /אישור/);
  assert.doesNotMatch(ctx, /2026-09-01/);
});
