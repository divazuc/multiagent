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
