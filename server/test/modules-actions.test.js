import test from 'node:test';
import assert from 'node:assert/strict';
import { extractModuleAction } from '../lib/modules/actions.js';

test('extracts and strips a valid action', () => {
  const r = extractModuleAction('מעולה, קבעתי לך!\n<<ACTION:calendar.book{"slot":"2026-08-02T10:00","name":"דנה"}>>');
  assert.equal(r.text, 'מעולה, קבעתי לך!');
  assert.deepEqual(r.action, { module: 'calendar', name: 'book', payload: { slot: '2026-08-02T10:00', name: 'דנה' } });
});

test('no marker → text unchanged, action null', () => {
  const r = extractModuleAction('שלום! איך אפשר לעזור?');
  assert.equal(r.text, 'שלום! איך אפשר לעזור?');
  assert.equal(r.action, null);
});

test('malformed JSON → marker stripped, action null', () => {
  const r = extractModuleAction('טקסט <<ACTION:calendar.book{"slot": nope}>> עוד');
  assert.ok(!r.text.includes('ACTION'));
  assert.equal(r.action, null);
});

test('multiple markers → first action wins, all stripped', () => {
  const r = extractModuleAction('א <<ACTION:calendar.book{"slot":"a"}>> ב <<ACTION:calendar.book{"slot":"b"}>>');
  assert.equal(r.action.payload.slot, 'a');
  assert.ok(!r.text.includes('ACTION'));
});
