import test from 'node:test';
import assert from 'node:assert/strict';
import { matchDirectKb, DIRECT_MATCH } from '../lib/kb-direct-match.js';

const ROWS = [
  { question: 'מה שעות הפעילות שלכם?', answer: 'אנחנו פתוחים בימים א-ה בין 9:00 ל-18:00.', category: 'שעות' },
  { question: 'איך מבטלים מנוי?', answer: 'אפשר לבטל מנוי בהודעה בוואטסאפ עד 48 שעות מראש.', category: 'מנוי' },
];

test('exact question match answers directly, verbatim from the row', () => {
  const hit = matchDirectKb({ message: 'מה שעות הפעילות שלכם?', rows: ROWS });
  assert.ok(hit, 'an exact question must match');
  assert.equal(hit.question, ROWS[0].question);
  assert.equal(hit.answer, ROWS[0].answer);
});

test('a near-exact paraphrase (same words, minor noise) still matches', () => {
  const hit = matchDirectKb({ message: 'מה שעות הפעילות שלכם בבקשה?', rows: ROWS });
  assert.ok(hit);
  assert.equal(hit.question, ROWS[0].question);
});

test('a low-confidence paraphrase falls through to the model path (null)', () => {
  // Shares almost nothing with either stored question — no near-exact match,
  // no overwhelming score margin.
  const hit = matchDirectKb({ message: 'אתם עובדים גם בחגים?', rows: ROWS });
  assert.equal(hit, null);
});

test('non-trivial conversation history always forces the model path, even for an exact question', () => {
  const hit = matchDirectKb({ message: 'מה שעות הפעילות שלכם?', rows: ROWS, historyNonTrivial: true });
  assert.equal(hit, null);
});

test('a bare greeting never takes the direct path', () => {
  for (const greeting of ['היי', 'שלום', 'הי', 'hi', 'hello']) {
    assert.equal(matchDirectKb({ message: greeting, rows: ROWS }), null, greeting);
  }
});

test('a multi-part message (more than one question mark) is not standalone-question shaped', () => {
  const hit = matchDirectKb({
    message: 'מה שעות הפעילות שלכם? ואיך מבטלים מנוי?',
    rows: ROWS,
  });
  assert.equal(hit, null);
});

test('an overly long, rambling message is not standalone-question shaped', () => {
  const rambling = Array.from({ length: DIRECT_MATCH.maxWords + 5 }, (_, i) => `מילה${i}`).join(' ') + ' שעות';
  assert.equal(matchDirectKb({ message: rambling, rows: ROWS }), null);
});

test('no rows at all always falls through to the model path', () => {
  assert.equal(matchDirectKb({ message: 'מה שעות הפעילות שלכם?', rows: [] }), null);
  assert.equal(matchDirectKb({ message: 'מה שעות הפעילות שלכם?', rows: undefined }), null);
});

test('an empty message never matches', () => {
  assert.equal(matchDirectKb({ message: '', rows: ROWS }), null);
  assert.equal(matchDirectKb({ message: '   ', rows: ROWS }), null);
});
