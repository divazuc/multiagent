// Cost-efficiency pass (2026-08-12), item 4: a HIGH-CONFIDENCE FAQ hit — the
// customer basically typed the stored question — should never cost a model
// call at all. This sits in front of everything else in
// agents/conversation.js#runConversation: no intent detection, no reply
// generation, the stored answer goes out verbatim (through the same
// reply-delay + outbound sanitizer every other reply uses).
//
// Precision over recall, deliberately conservative — a wrong direct answer
// is worse than one extra model call:
//   - conversation history must be empty. Any follow-up-shaped turn ("and
//     what about...", "ok but...") needs the model's context, full stop —
//     historyNonTrivial is checked before anything else and short-circuits
//     the whole match.
//   - the message itself must look like ONE standalone question: not a bare
//     greeting, not multi-part (more than one '?'), not a rambling multi-
//     sentence message pretending to be a question.
//   - even then, only a NEAR-EXACT match to a stored question (high Jaccard
//     word overlap) or an OVERWHELMING scoring margin over every other row
//     qualifies — a merely-plausible top match still goes to the model.
//
// Reuses kb-retrieval.js's scoring engine so a row that would rank #1 for
// retrieval is the same row direct-match considers; it just applies a much
// higher bar before answering without the model in the loop at all.

import { normalizeHebrew, scoreRow } from './kb-retrieval.js';

// Exported for tests / tuning visibility — these are the exact numbers that
// decide "direct answer" vs "ask the model".
export const DIRECT_MATCH = Object.freeze({
  jaccardThreshold: 0.85, // near-exact: 85%+ of the normalized words agree
  minScoreForMargin: 6,   // at least ~2 full question-word hits (weight 3 each)
  marginRatio: 3,         // and at least 3x the runner-up's score
  maxWords: 25,           // longer than this reads as multi-part, not one question
});

const GREETINGS = new Set([
  'הי', 'היי', 'שלום', 'אהלן', 'בוקר טוב', 'ערב טוב', 'לילה טוב', 'מה נשמע', 'מה קורה',
  'hi', 'hello', 'hey', 'yo', 'good morning', 'good evening',
]);

function isStandaloneQuestionShape(message) {
  const trimmed = String(message ?? '').trim();
  if (!trimmed) return false;
  if (GREETINGS.has(trimmed.toLowerCase())) return false;
  const questionMarks = (trimmed.match(/\?/g) ?? []).length;
  if (questionMarks > 1) return false;
  const words = normalizeHebrew(trimmed);
  if (words.length === 0 || words.length > DIRECT_MATCH.maxWords) return false;
  return true;
}

function jaccard(aWords, bWords) {
  const a = new Set(aWords);
  const b = new Set(bWords);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

function isNearExactMatch(message, question) {
  return jaccard(normalizeHebrew(message), normalizeHebrew(question)) >= DIRECT_MATCH.jaccardThreshold;
}

// Returns { question, answer } for a confident hit, or null — meaning "take
// the normal model path".
export function matchDirectKb({ message, rows, historyNonTrivial = false }) {
  if (historyNonTrivial) return null;
  if (!isStandaloneQuestionShape(message)) return null;
  if (!rows?.length) return null;

  const messageWordSet = new Set(normalizeHebrew(message));
  if (!messageWordSet.size) return null;

  const scored = rows
    .map((row) => ({ row, score: scoreRow(messageWordSet, row) }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top || top.score === 0) return null;

  const runnerUpScore = scored[1]?.score ?? 0;
  const nearExact = isNearExactMatch(message, top.row.question);
  const overwhelmingMargin = top.score >= DIRECT_MATCH.minScoreForMargin &&
    (runnerUpScore === 0 || top.score / runnerUpScore >= DIRECT_MATCH.marginRatio);

  if (!nearExact && !overwhelmingMargin) return null;
  return { question: top.row.question, answer: top.row.answer };
}
