import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeBusy, freeBusyItems } from '../lib/modules/calendar/freebusy.js';

test('freeBusyItems always includes the primary calendar', () => {
  assert.deepEqual(freeBusyItems([]), [{ id: 'primary' }]);
});

test('freeBusyItems appends the configured extra calendars', () => {
  assert.deepEqual(freeBusyItems(['divazuc@gmail.com']), [
    { id: 'primary' }, { id: 'divazuc@gmail.com' },
  ]);
});

test('freeBusyItems ignores blanks and duplicates of primary', () => {
  assert.deepEqual(freeBusyItems(['', '  ', 'primary', 'a@b.com', 'a@b.com']), [
    { id: 'primary' }, { id: 'a@b.com' },
  ]);
});

test('mergeBusy combines the busy blocks of every calendar', () => {
  // The bug this replaces: only calendars.primary.busy was read, so a second
  // calendar full of real commitments was invisible and its times were offered.
  const body = {
    calendars: {
      primary: { busy: [{ start: '2026-07-28T09:00:00Z', end: '2026-07-28T10:00:00Z' }] },
      'divazuc@gmail.com': { busy: [{ start: '2026-07-28T12:00:00Z', end: '2026-07-28T13:00:00Z' }] },
    },
  };
  const out = mergeBusy(body);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(b => b.start).sort(), [
    '2026-07-28T09:00:00Z', '2026-07-28T12:00:00Z',
  ]);
});

test('a calendar that errors is skipped without losing the others', () => {
  // Google returns notFound for calendars the account cannot freeBusy, e.g. the
  // Israeli holidays feed. One bad id must not blind us to the good ones.
  const body = {
    calendars: {
      primary: { busy: [{ start: '2026-07-28T09:00:00Z', end: '2026-07-28T10:00:00Z' }] },
      'en.jewish#holiday@group.v.calendar.google.com': {
        busy: [], errors: [{ domain: 'global', reason: 'notFound' }],
      },
    },
  };
  assert.equal(mergeBusy(body).length, 1);
});

test('an empty or malformed body yields no busy blocks rather than throwing', () => {
  assert.deepEqual(mergeBusy({}), []);
  assert.deepEqual(mergeBusy(null), []);
  assert.deepEqual(mergeBusy({ calendars: { primary: {} } }), []);
});

test('overlapping blocks from different calendars are both kept', () => {
  // computeSlots does its own overlap filtering; merging must not silently drop
  // a block just because another calendar covers part of the same time.
  const body = {
    calendars: {
      primary: { busy: [{ start: '2026-07-28T09:00:00Z', end: '2026-07-28T11:00:00Z' }] },
      other: { busy: [{ start: '2026-07-28T10:00:00Z', end: '2026-07-28T12:00:00Z' }] },
    },
  };
  assert.equal(mergeBusy(body).length, 2);
});
