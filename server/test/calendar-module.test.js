import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.MODULE_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
const calendar = (await import('../lib/modules/calendar/index.js')).default;
const { _setProviderForTest } = await import('../lib/modules/calendar/index.js');

const created = [];
_setProviderForTest({
  freeBusy: async () => [],
  createEvent: async (_s, ev) => { created.push(ev); return { eventId: 'ev1', htmlLink: 'http://cal/ev1' }; },
});

function row(settings = {}) {
  return {
    business_id: 'b1', module_key: 'calendar', enabled: true, status: 'connected',
    secrets: {}, settings: {
      provider: 'fake', mode: 'autonomous', duration_min: 30, buffer_min: 0,
      horizon_days: 7, min_notice_hours: 0,
      weekly: {
        sun: [{ from: '10:00', to: '12:00' }], mon: [{ from: '10:00', to: '12:00' }],
        tue: [{ from: '10:00', to: '12:00' }], wed: [{ from: '10:00', to: '12:00' }],
        thu: [{ from: '10:00', to: '12:00' }], fri: [], sat: [],
      },
      overrides: {}, jewish_holidays_closed: true, event_title: 'פגישה — {name}',
      ...settings,
    },
  };
}
const BIZ = { id: 'b1', name: 'קליניקה' };

test('settings schema applies defaults and rejects bad mode', () => {
  const ok = calendar.settingsSchema.safeParse({ weekly: {} });
  assert.ok(ok.success);
  assert.equal(ok.data.mode, 'owner_confirmed');
  assert.ok(!calendar.settingsSchema.safeParse({ mode: 'yolo' }).success);
});

test('contextProvider returns a Hebrew slots block', async () => {
  const ctx = await calendar.contextProvider(BIZ, row());
  assert.ok(ctx.includes('תיאום פגישות'));
  assert.ok(ctx.includes('<<ACTION:calendar.book'));
});

test('book action creates an event and confirms (autonomous)', async () => {
  const slots = await calendar._computeCurrentSlots(row());
  const slot = `${slots[0].date}T${slots[0].from}`;
  const r = await calendar.actions.book.handler(BIZ, row(), { slot, name: 'דנה', phone: '0501234567' }, { session_id: '0501234567' });
  assert.ok(r.confirmationText.includes('נקבעה'));
  assert.equal(created.length, 1);
  assert.ok(created[0].title.includes('דנה'));
});

test('slot not on the list → failure text with alternatives, no event', async () => {
  created.length = 0;
  const r = await calendar.actions.book.handler(BIZ, row(), { slot: '2030-01-01T03:00', name: 'דנה' }, {});
  assert.ok(r.failureText);
  assert.equal(created.length, 0);
});

test('race: slot busy on re-check → failure text, no event', async () => {
  created.length = 0;
  const slots = await calendar._computeCurrentSlots(row());
  const slot = `${slots[0].date}T${slots[0].from}`;
  // Wide (horizon) freeBusy query → free; narrow (single-slot re-check) → busy.
  // This makes the slot pass the list check but fail the race re-check.
  _setProviderForTest({
    freeBusy: async (_s, from, to) =>
      (new Date(to) - new Date(from) <= 3600000) ? [{ start: from, end: to }] : [],
    createEvent: async () => { throw new Error('must not be called'); },
  });
  const r = await calendar.actions.book.handler(BIZ, row(), { slot, name: 'דנה' }, {});
  assert.ok(r.failureText.includes('נתפס'));
  assert.equal(created.length, 0);
});

// T6 (funnel track 1): a general seam — the caller (the reply pipeline, via
// the booking gate) can hand a fully-formed event title through sessionCtx.
// The calendar module stays generic: no booster knowledge in here, just
// "the decision layer already named this meeting".
test('sessionCtx.event_title_override replaces the configured event title verbatim', async () => {
  _setProviderForTest({
    freeBusy: async () => [],
    createEvent: async (_s, ev) => { created.push(ev); return { eventId: 'ev3', htmlLink: '' }; },
  });
  created.length = 0;
  const slots = await calendar._computeCurrentSlots(row());
  const slot = `${slots[0].date}T${slots[0].from}`;
  const r = await calendar.actions.book.handler(BIZ, row(), { slot, name: 'דנה' },
    { session_id: '0501234567', event_title_override: 'פגישת אפיון — הזמנה DZ-2026-1042' });
  assert.ok(r.confirmationText);
  assert.equal(created[0].title, 'פגישת אפיון — הזמנה DZ-2026-1042',
    'the override is used verbatim — settings.event_title and {name} templating are bypassed');
});

test('event_title_override still gets the tentative prefix under owner_confirmed', async () => {
  _setProviderForTest({
    freeBusy: async () => [],
    createEvent: async (_s, ev) => { created.push(ev); return { eventId: 'ev4', htmlLink: '' }; },
  });
  created.length = 0;
  const r = row({ mode: 'owner_confirmed' });
  const slots = await calendar._computeCurrentSlots(r);
  await calendar.actions.book.handler(BIZ, r, { slot: `${slots[0].date}T${slots[0].from}`, name: 'דנה' },
    { session_id: '0501234567', event_title_override: 'פגישת אפיון — הזמנה DZ-1' });
  assert.equal(created[0].title, '⏳ ממתין לאישור: פגישת אפיון — הזמנה DZ-1',
    'owner-confirmed mode must still mark the event as pending, override or not');
});

// The reply pipeline used to infer "booked" from this module's Hebrew copy
// (!includes('נתפס') && !includes('לא זמין')), so any new failure string here
// would silently have become a booking upstream. Every path now reports a
// structured result too — and the text stays byte-for-byte what it was.
test('book reports a structured result on every path, with its existing text unchanged', async () => {
  _setProviderForTest({
    freeBusy: async () => [],
    createEvent: async (_s, ev) => { created.push(ev); return { eventId: 'ev5', htmlLink: '' }; },
  });
  created.length = 0;
  const auto = row();
  const slots = await calendar._computeCurrentSlots(auto);

  const ok = await calendar.actions.book.handler(BIZ, auto, { slot: `${slots[0].date}T${slots[0].from}`, name: 'דנה' }, {});
  assert.deepEqual(ok.result, { ok: true, tentative: false });
  assert.ok(ok.confirmationText.includes('נקבעה'), 'existing autonomous copy is unchanged');

  const gone = await calendar.actions.book.handler(BIZ, auto, { slot: '2030-01-01T03:00', name: 'דנה' }, {});
  assert.deepEqual(gone.result, { ok: false });
  assert.ok(gone.failureText.includes('לא זמין'));
});

test('book under owner_confirmed reports tentative:true — a request, not a booking', async () => {
  _setProviderForTest({
    freeBusy: async () => [],
    createEvent: async (_s, ev) => { created.push(ev); return { eventId: 'ev6', htmlLink: '' }; },
  });
  created.length = 0;
  const pending = row({ mode: 'owner_confirmed' });
  const slots = await calendar._computeCurrentSlots(pending);
  const r = await calendar.actions.book.handler(BIZ, pending, { slot: `${slots[0].date}T${slots[0].from}`, name: 'דנה' }, {});
  assert.deepEqual(r.result, { ok: true, tentative: true },
    'the DEFAULT mode returns a pending request — a caller must be able to tell it from a confirmed meeting');
  assert.ok(r.confirmationText.includes('נאשר לך סופית'), 'existing owner-confirmed copy is unchanged');
});

test('book reports ok:false when the slot is taken in the race re-check', async () => {
  _setProviderForTest({
    freeBusy: async (_s, from, to) => (new Date(to) - new Date(from) <= 3600000) ? [{ start: from, end: to }] : [],
    createEvent: async () => { throw new Error('must not be called'); },
  });
  const auto = row();
  const slots = await calendar._computeCurrentSlots(auto);
  const r = await calendar.actions.book.handler(BIZ, auto, { slot: `${slots[0].date}T${slots[0].from}`, name: 'דנה' }, {});
  assert.deepEqual(r.result, { ok: false });
  assert.ok(r.failureText.includes('נתפס'));
});

test('owner_confirmed creates tentative title and notifies softly', async () => {
  _setProviderForTest({
    freeBusy: async () => [],
    createEvent: async (_s, ev) => { created.push(ev); return { eventId: 'ev2', htmlLink: '' }; },
  });
  created.length = 0;
  const r = row({ mode: 'owner_confirmed' });
  const slots = await calendar._computeCurrentSlots(r);
  const res = await calendar.actions.book.handler(BIZ, r, { slot: `${slots[0].date}T${slots[0].from}`, name: 'דנה' }, {});
  assert.ok(created[0].title.startsWith('⏳ ממתין לאישור'));
  assert.ok(res.confirmationText);
});
