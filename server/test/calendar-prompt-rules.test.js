import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSlotsContext } from '../lib/modules/calendar/slots.js';

const SLOTS = [
  { date: '2026-07-28', from: '14:15', to: '14:45' },
  { date: '2026-07-30', from: '14:15', to: '14:45' },
];
const SETTINGS = { duration_min: 30 };

test('the slot list carries the weekday next to each date', () => {
  // A live run offered "יום שלישי 29.7" when 29.7 was a Wednesday. The model
  // must read the day off the list rather than deriving it.
  const ctx = formatSlotsContext(SLOTS, SETTINGS);
  assert.match(ctx, /שלישי 28\/07\/2026/); // dd/mm/yyyy for the client (2026-08-29); the ISO key follows in brackets
  assert.match(ctx, /חמישי 30\/07\/2026/);
  assert.match(ctx, /אל תחשב\/י בעצמך איזה יום בשבוע/);
});

test('announcing the booking before the server executes is forbidden', () => {
  // The same run told the lead "נתראה ביום שלישי 🎉" and was immediately
  // contradicted by the server refusing the slot.
  const ctx = formatSlotsContext(SLOTS, SETTINGS);
  assert.match(ctx, /אל תכתוב\/י "נתראה"/);
  assert.match(ctx, /הכרזה מוקדמת תסתור את ההודעה/);
});

test('inventing meeting details is forbidden by name', () => {
  // It also invented "בזום" and promised to send login details. Nothing in the
  // configuration mentions Zoom.
  const ctx = formatSlotsContext(SLOTS, SETTINGS);
  assert.match(ctx, /לא מיקום/);
  assert.match(ctx, /לא זום או לינק/);
  assert.match(ctx, /אשלח פרטים בהמשך/);
});

test('with no free slots it still refuses to invent times', () => {
  const ctx = formatSlotsContext([], SETTINGS);
  assert.match(ctx, /אין להמציא מועדים/);
  assert.ok(!ctx.includes('<<ACTION'), 'no booking protocol when nothing can be booked');
});
