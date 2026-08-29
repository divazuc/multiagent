import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSlotOffer } from '../lib/booster-meeting.js';
import { formatSlotsContext } from '../lib/modules/calendar/slots.js';
import { formatSlotForClient } from '../lib/modules/calendar/index.js';
import { hebDateDMY } from '../lib/heb-date.js';

// Owner, 2026-08-29 (Diva Ost E2E): the meeting offer read "יום שני 2026-08-31
// בשעה 11:30" — an ISO date inside a Hebrew sentence. Clients read dd/mm/yyyy,
// and the digits must stay left-to-right: ASCII "/" (or "-") between digits is
// a common separator, so the run renders as one LTR number; the ISO order was
// the actual complaint. Three surfaces produce that date — the fixed slot
// offer, the calendar context the model copies from, and the module's own
// confirmation/alternatives lines — and all three now agree.

test('hebDateDMY: ISO yyyy-mm-dd → dd/mm/yyyy; anything else passes through untouched', () => {
  assert.equal(hebDateDMY('2026-08-31'), '31/08/2026');
  assert.equal(hebDateDMY('2026-08-31T11:30'), '31/08/2026', 'a datetime keeps only its date');
  assert.equal(hebDateDMY('31/08/2026'), '31/08/2026');
  assert.equal(hebDateDMY(''), '');
  assert.equal(hebDateDMY(null), '');
});

test('formatSlotOffer prints the day of week and dd/mm/yyyy — never the ISO date', () => {
  const msg = formatSlotOffer([
    { date: '2026-08-31', from: '11:30' }, { date: '2026-08-31', from: '12:30' },
    { date: '2026-09-02', from: '11:30' },
  ], { quoteNumber: 'DZ-2026-2988' });
  assert.match(msg, /יום שני 31\/08\/2026: 11:30, 12:30/);
  assert.match(msg, /יום רביעי 02\/09\/2026: 11:30/);
  assert.doesNotMatch(msg, /2026-0[89]-/, 'no ISO date reaches the client');
  assert.match(msg, /DZ-2026-2988/);
});

test('formatSlotsContext shows the model the human date to SAY, keeps the ISO key it must BOOK with, and says so', () => {
  const ctx = formatSlotsContext([
    { date: '2026-08-31', from: '11:30', to: '12:00' }, { date: '2026-09-02', from: '11:30', to: '12:00' },
  ], { duration_min: 30 });
  assert.match(ctx, /יום שני 31\/08\/2026/);
  assert.match(ctx, /2026-08-31/, 'the ISO date stays available — calendar.book needs YYYY-MM-DDTHH:MM');
  assert.match(ctx, /31\/08\/2026/);
  // The model is told which of the two forms the customer sees.
  assert.match(ctx, /31\/08\/2026[^\n]*ללקוח|ללקוח[^\n]*31\/08\/2026|בפורמט 31\/08\/2026|כמו 31\/08\/2026/);
  assert.match(ctx, /calendar\.book\{"slot":"YYYY-MM-DDTHH:MM"/, 'the action format is unchanged');
});

test('formatSlotForClient: the module\'s own confirmation/alternatives lines use dd/mm/yyyy', () => {
  assert.equal(formatSlotForClient('2026-08-31', '11:30'), 'יום שני 31/08/2026 בשעה 11:30');
});
