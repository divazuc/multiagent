import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockedReplyFor, BLOCKED_REPLY } from '../lib/booster-meeting.js';

// Owner, 2026-08-29 (Diva Ost E2E): with a confirmed meeting already on the
// calendar the client asked for another time and got the bare "דיוה תחזור אליך
// בהקדם 🙂" — "שוב תשובה גנרית". The one-meeting gate stays; its reply now says
// what the system knows: the meeting that exists (dd/mm/yyyy + time), or the
// request still waiting for approval, and that a change goes through Diva.

const booked = { detail: { slot: '2026-09-01T14:15', quote_number: 'DZ-2026-2988' } };
const requested = { detail: { slot: '2026-09-01T14:15', quote_number: 'DZ-2026-2988' } };

test('a confirmed meeting: names it (weekday, dd/mm/yyyy, time) and offers a change through Diva', () => {
  const text = blockedReplyFor({ booked, requested: null });
  assert.match(text, /יום שלישי 01\/09\/2026 בשעה 14:15/);
  assert.match(text, /כבר יש לך פגישת אפיון/);
  assert.match(text, /דיוה/);
  assert.doesNotMatch(text, /2026-09-01/, 'no ISO date reaches the client');
});

test('a request still awaiting approval: says so, with the slot, and that Diva is coming back', () => {
  const text = blockedReplyFor({ booked: null, requested });
  assert.match(text, /ממתין לאישור/);
  assert.match(text, /יום שלישי 01\/09\/2026 בשעה 14:15/);
  assert.match(text, /דיוה/);
});

test('a confirmed meeting wins over an older pending request in the wording', () => {
  const text = blockedReplyFor({ booked, requested });
  assert.match(text, /כבר יש לך פגישת אפיון/);
});

test('nothing known about the hold (wrong stage, no notes): the locked line, unchanged', () => {
  assert.equal(blockedReplyFor({ booked: null, requested: null }), BLOCKED_REPLY);
  assert.equal(blockedReplyFor({}), BLOCKED_REPLY);
  // A note without a usable slot falls back too — never "בשעה undefined".
  assert.equal(blockedReplyFor({ booked: { detail: {} } }), BLOCKED_REPLY);
});
