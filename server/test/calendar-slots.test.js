import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSlots, formatSlotsContext, ilWallToUtc, utcToIlWall } from '../lib/modules/calendar/slots.js';

// Sun 2026-08-02 08:00 IL wall clock as the fixed "now" for all tests
const NOW = new Date(2026, 7, 2, 8, 0, 0);
const BASE = {
  duration_min: 30, buffer_min: 0, horizon_days: 7, min_notice_hours: 2,
  weekly: { sun: [{ from: '10:00', to: '12:00' }], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
  overrides: {}, jewish_holidays_closed: true,
};
const S = (o = {}) => ({ ...BASE, ...o });

test('generates slots inside weekly window, earliest first', () => {
  const slots = computeSlots({ settings: S(), busy: [], now: NOW, holidays: new Set() });
  assert.deepEqual(slots[0], { date: '2026-08-02', from: '10:00', to: '10:30' });
  assert.deepEqual(slots.map(s => s.from).slice(0, 4), ['10:00', '10:30', '11:00', '11:30']);
  // next sunday too (horizon 7 days)
  assert.ok(slots.some(s => s.date === '2026-08-09'));
});

test('min_notice pushes past early slots', () => {
  const slots = computeSlots({ settings: S({ min_notice_hours: 3 }), busy: [], now: NOW, holidays: new Set() });
  assert.equal(slots[0].from, '11:00'); // now 08:00 + 3h = 11:00
});

test('busy event blocks overlapping slots; touching boundaries do not block', () => {
  const busy = [{ start: new Date(2026, 7, 2, 10, 30), end: new Date(2026, 7, 2, 11, 0) }];
  const slots = computeSlots({ settings: S(), busy, now: NOW, holidays: new Set() });
  const today = slots.filter(s => s.date === '2026-08-02').map(s => s.from);
  assert.deepEqual(today, ['10:00', '11:00', '11:30']); // 10:30 blocked; 10:00 & 11:00 touch but fit
});

test('duration that no longer fits in the window rolls to the next day', () => {
  const busy = [{ start: new Date(2026, 7, 2, 10, 0), end: new Date(2026, 7, 2, 11, 45) }];
  const slots = computeSlots({ settings: S({ duration_min: 30 }), busy, now: NOW, holidays: new Set() });
  // remaining 11:45-12:00 = 15min < 30min → nothing today, first slot next Sunday
  assert.equal(slots[0].date, '2026-08-09');
});

test('buffer spaces candidates', () => {
  const slots = computeSlots({ settings: S({ buffer_min: 15 }), busy: [], now: NOW, holidays: new Set() });
  const today = slots.filter(s => s.date === '2026-08-02').map(s => s.from);
  assert.deepEqual(today, ['10:00', '10:45', '11:30']); // step 45; 11:30+30=12:00 fits exactly
});

test('per-date override replaces weekly; empty array closes the day', () => {
  const settings = S({ overrides: { '2026-08-02': [{ from: '14:00', to: '15:00' }], '2026-08-09': [] } });
  const slots = computeSlots({ settings, busy: [], now: NOW, holidays: new Set() });
  assert.equal(slots[0].from, '14:00');
  assert.ok(!slots.some(s => s.date === '2026-08-09'));
});

test('holiday closes the day when configured', () => {
  const slots = computeSlots({ settings: S(), busy: [], now: NOW, holidays: new Set(['2026-08-02']) });
  assert.ok(!slots.some(s => s.date === '2026-08-02'));
});

test('timezone helpers round-trip (IL summer = UTC+3)', () => {
  const utc = ilWallToUtc('2026-08-02', '10:00');
  assert.equal(utc.toISOString(), '2026-08-02T07:00:00.000Z');
  const wall = utcToIlWall(utc);
  assert.equal(wall.getHours(), 10);
});

test('context block is Hebrew, capped, and carries the action instruction', () => {
  const slots = computeSlots({ settings: S({ horizon_days: 14 }), busy: [], now: NOW, holidays: new Set() });
  const text = formatSlotsContext(slots, S());
  assert.ok(text.includes('<<ACTION:calendar.book'));
  assert.ok(text.includes('2026-08-02'));
  assert.ok((text.match(/\d{2}:\d{2}/g) || []).length <= 90); // capped output
});

test('empty availability yields a no-slots instruction, never invented times', () => {
  const text = formatSlotsContext([], S());
  assert.ok(text.includes('אין כרגע מועדים פנויים'));
  assert.ok(!text.includes('<<ACTION'));
});
