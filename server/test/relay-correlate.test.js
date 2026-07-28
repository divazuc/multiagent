import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRepMessage, isStopMessage, resolveEscalation } from '../lib/relay/correlate.js';

const ROWS = [
  { id: 'e2', short_code: 7, rep_message_id: 'wamid.BBB', session_id: '97250000002' },
  { id: 'e1', short_code: 3, rep_message_id: 'wamid.AAA', session_id: '97250000001' },
]; // newest first

test('parseRepMessage strips a leading short code', () => {
  assert.deepEqual(parseRepMessage('#3 כן, עד 3 תשלומים'), { code: 3, body: 'כן, עד 3 תשלומים' });
});

test('parseRepMessage leaves a plain message untouched', () => {
  assert.deepEqual(parseRepMessage('כן, אפשר'), { code: null, body: 'כן, אפשר' });
});

test('isStopMessage matches a whole-message stop word only', () => {
  assert.equal(isStopMessage('עצור'), true);
  assert.equal(isStopMessage('  STOP.  '), true);
  assert.equal(isStopMessage('די יקר, אבל אפשר לפרוס'), false);
});

test('a quoted message wins over everything else', () => {
  const r = resolveEscalation({ contextId: 'wamid.AAA', text: '#7 משהו', openRows: ROWS });
  assert.equal(r.row.id, 'e1');
  assert.equal(r.matchedBy, 'quote');
});

test('a short code resolves when there is no quote', () => {
  const r = resolveEscalation({ contextId: null, text: '#3 כן', openRows: ROWS });
  assert.equal(r.row.id, 'e1');
  assert.equal(r.matchedBy, 'code');
  assert.equal(r.body, 'כן');
});

test('a single open escalation needs no code', () => {
  const r = resolveEscalation({ contextId: null, text: 'כן', openRows: [ROWS[1]] });
  assert.equal(r.row.id, 'e1');
  assert.equal(r.matchedBy, 'single');
});

test('with several open and no hint, the newest wins and is flagged as a guess', () => {
  const r = resolveEscalation({ contextId: null, text: 'כן', openRows: ROWS });
  assert.equal(r.row.id, 'e2');
  assert.equal(r.matchedBy, 'recent');
});

test('nothing open resolves to null', () => {
  const r = resolveEscalation({ contextId: null, text: 'כן', openRows: [] });
  assert.equal(r.row, null);
  assert.equal(r.matchedBy, null);
});

test('a stop message is flagged and still resolves to a row', () => {
  const r = resolveEscalation({ contextId: null, text: '#3 עצור', openRows: ROWS });
  assert.equal(r.row.id, 'e1');
  assert.equal(r.isStop, true);
});
