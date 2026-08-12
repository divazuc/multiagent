import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHebrew, scoreRow, retrieveTopK, formatKbContextBlock } from '../lib/kb-retrieval.js';

const ROWS = [
  { question: 'מה שעות הפעילות שלכם?', answer: 'אנחנו פתוחים בימים א-ה בין 9:00 ל-18:00.', category: 'שעות' },
  { question: 'איך מבטלים מנוי?', answer: 'אפשר לבטל מנוי בהודעה בוואטסאפ עד 48 שעות מראש.', category: 'מנוי' },
  { question: 'האם יש חניה?', answer: 'כן, יש חניה חינם ליד הבניין.', category: 'לוגיסטיקה' },
];

test('normalizeHebrew strips niqqud and punctuation, then splits on whitespace', () => {
  assert.deepEqual(normalizeHebrew('שָׁלוֹם, מה שלומך??'), ['שלום', 'מה', 'שלומך']);
  assert.deepEqual(normalizeHebrew('  שלום   עולם  '), ['שלום', 'עולם']);
});

test('normalizeHebrew handles null/undefined/empty without throwing', () => {
  assert.deepEqual(normalizeHebrew(null), []);
  assert.deepEqual(normalizeHebrew(undefined), []);
  assert.deepEqual(normalizeHebrew(''), []);
});

test('scoreRow weighs a question-word hit above an answer-word hit', () => {
  const qHitOnly = new Set(['שעות']); // matches ROWS[0].question AND appears in ROWS[1].answer
  const scoreQuestionRow = scoreRow(qHitOnly, ROWS[0]); // hits in question -> higher weight
  const scoreAnswerOnlyRow = scoreRow(qHitOnly, ROWS[1]); // hits only in answer text
  assert.ok(scoreQuestionRow > scoreAnswerOnlyRow,
    `question-word hit (${scoreQuestionRow}) must outrank an answer-only hit (${scoreAnswerOnlyRow})`);
});

test('scoreRow gives a category bonus when a message word matches the category', () => {
  const messageWords = new Set(['מנוי']); // matches ROWS[1].category exactly, and its question
  const withCategoryHit = scoreRow(messageWords, ROWS[1]);
  const withoutCategoryHit = scoreRow(messageWords, ROWS[0]); // no overlap anywhere
  assert.ok(withCategoryHit > withoutCategoryHit);
  assert.equal(withoutCategoryHit, 0);
});

test('retrieveTopK ranks the clearly relevant row first', () => {
  const scored = retrieveTopK({ message: 'מה שעות הפעילות שלכם בבקשה?', rows: ROWS });
  assert.ok(scored.length >= 1);
  assert.equal(scored[0].row.question, ROWS[0].question);
});

test('retrieveTopK drops rows with zero overlap entirely', () => {
  const scored = retrieveTopK({ message: 'מה שעות הפעילות שלכם?', rows: ROWS });
  // ROWS[2] (parking) shares no words with the query — must not appear
  assert.ok(!scored.some(s => s.row.question === ROWS[2].question));
});

test('retrieveTopK respects the topK limit (default 8)', () => {
  const manyRows = Array.from({ length: 20 }, (_, i) => ({
    question: `שאלה מספר ${i} על שעות`, answer: 'תשובה כללית', category: 'כללי',
  }));
  const scored = retrieveTopK({ message: 'שעות', rows: manyRows });
  assert.equal(scored.length, 8);
  const scoredCustom = retrieveTopK({ message: 'שעות', rows: manyRows, topK: 3 });
  assert.equal(scoredCustom.length, 3);
});

test('retrieveTopK returns [] for an empty message, empty rows, or no overlap at all', () => {
  assert.deepEqual(retrieveTopK({ message: '', rows: ROWS }), []);
  assert.deepEqual(retrieveTopK({ message: 'מה שעות', rows: [] }), []);
  assert.deepEqual(retrieveTopK({ message: 'מה שעות', rows: undefined }), []);
  assert.deepEqual(retrieveTopK({ message: 'קסם ופלא', rows: ROWS }), []);
});

test('formatKbContextBlock renders Q/A pairs and the anti-hallucination guard line', () => {
  const scored = retrieveTopK({ message: 'מה שעות הפעילות שלכם?', rows: ROWS });
  const block = formatKbContextBlock(scored);
  assert.match(block, /Q: מה שעות הפעילות שלכם\?/);
  assert.match(block, /A: אנחנו פתוחים/);
  assert.match(block, /אם אין במידע תשובה — אל תמציא\./);
});

test('formatKbContextBlock returns an empty string for no matches', () => {
  assert.equal(formatKbContextBlock([]), '');
  assert.equal(formatKbContextBlock(undefined), '');
});
