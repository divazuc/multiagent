import test from 'node:test';
import assert from 'node:assert/strict';
import { matchDirectKb, matchMultiDirectKb, segmentQuestions, DIRECT_MATCH } from '../lib/kb-direct-match.js';

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

test('a near-exact match still answers directly even with non-trivial conversation history ("תשובות חוזרות")', () => {
  const hit = matchDirectKb({ message: 'מה שעות הפעילות שלכם?', rows: ROWS, historyNonTrivial: true });
  assert.ok(hit, 'near-exact must fire mid-conversation too');
  assert.equal(hit.question, ROWS[0].question);
  assert.equal(hit.answer, ROWS[0].answer);
});

test('the looser scoring-margin tier (no near-exact wording match) still requires empty history, unchanged', () => {
  // Same message as the "near-exact paraphrase" case above, but that case is
  // actually margin-tier, not near-exact: adding 'בבקשה' drops the jaccard
  // overlap with ROWS[0].question below the 0.85 near-exact threshold (4
  // shared / 5 total = 0.8), so it only qualifies via the score-vs-runner-up
  // margin — which is exactly the tier that must NOT fire mid-conversation.
  const hit = matchDirectKb({
    message: 'מה שעות הפעילות שלכם בבקשה?', rows: ROWS, historyNonTrivial: true,
  });
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

// ── segmentQuestions — pure text shaping ─────────────────────────────────────

test('segmentQuestions splits on "?" keeping the mark, and on newlines, trimming and dropping empties', () => {
  assert.deepEqual(
    segmentQuestions('מה שעות הפעילות שלכם? איך מבטלים מנוי?'),
    ['מה שעות הפעילות שלכם?', 'איך מבטלים מנוי?'],
  );
  assert.deepEqual(
    segmentQuestions('מה שעות הפעילות שלכם?\nאיך מבטלים מנוי?'),
    ['מה שעות הפעילות שלכם?', 'איך מבטלים מנוי?'],
  );
  assert.deepEqual(segmentQuestions('   '), []);
  assert.deepEqual(segmentQuestions(''), []);
  assert.deepEqual(segmentQuestions('שאלה יחידה בלי סימן שאלה'), ['שאלה יחידה בלי סימן שאלה']);
});

// ── matchMultiDirectKb — multi-question split ("both-direct only") ──────────

test('every segment near-exact-matching a DIFFERENT row -> a multi hit, in order', () => {
  const hit = matchMultiDirectKb({
    message: 'מה שעות הפעילות שלכם? איך מבטלים מנוי?', rows: ROWS,
  });
  assert.ok(hit?.multi, 'must be the multi shape');
  assert.equal(hit.hits.length, 2);
  assert.equal(hit.hits[0].question, ROWS[0].question);
  assert.equal(hit.hits[1].question, ROWS[1].question);
});

test('all segments landing on the SAME row collapse to one ordinary direct answer, not multi', () => {
  const hit = matchMultiDirectKb({
    message: 'מה שעות הפעילות שלכם? מה שעות הפעילות שלכם?', rows: ROWS,
  });
  assert.ok(hit);
  assert.equal(hit.multi, false);
  assert.equal(hit.question, ROWS[0].question);
  assert.equal(hit.answer, ROWS[0].answer);
});

test('one segment failing to near-exact-match anything falls through entirely (no partial credit)', () => {
  const hit = matchMultiDirectKb({
    message: 'מה שעות הפעילות שלכם? זה לגמרי לא קשור לשום שורה בבסיס הידע?', rows: ROWS,
  });
  assert.equal(hit, null);
});

test('fewer than 2 or more than 3 segments is not "multi" at all', () => {
  assert.equal(matchMultiDirectKb({ message: 'מה שעות הפעילות שלכם?', rows: ROWS }), null);
  const fourQuestions = 'מה שעות הפעילות שלכם? איך מבטלים מנוי? מה שעות הפעילות שלכם? איך מבטלים מנוי?';
  assert.equal(matchMultiDirectKb({ message: fourQuestions, rows: ROWS }), null);
});

test('matchMultiDirectKb falls through with no rows or an empty message', () => {
  assert.equal(matchMultiDirectKb({ message: 'מה שעות הפעילות שלכם? איך מבטלים מנוי?', rows: [] }), null);
  assert.equal(matchMultiDirectKb({ message: '', rows: ROWS }), null);
});
