// Cost-efficiency pass (2026-08-12), item 4: a HIGH-CONFIDENCE FAQ hit — the
// customer basically typed the stored question — should never cost a model
// call at all. This sits in front of everything else in
// agents/conversation.js#runConversation: no intent detection, no reply
// generation, the stored answer goes out verbatim (through the same
// reply-delay + outbound sanitizer every other reply uses).
//
// Precision over recall, deliberately conservative — a wrong direct answer
// is worse than one extra model call:
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
//
// Cost-efficiency pass 2 (2026-08-13), "תשובות חוזרות" (owner-approved):
// conversation history is no longer an automatic disqualifier for every tier.
//   - NEAR-EXACT (Jaccard >= jaccardThreshold) now fires mid-conversation
//     too. The customer typing something that matches a full stored question
//     almost word-for-word is strong evidence the message is self-contained
//     ("what are your hours?" mid-chat needs no more context than it would
//     as an opener) — worth the saving, still precision-first.
//   - The looser scoring-MARGIN tier (score-vs-runner-up, no near-exact
//     wording match) stays gated to empty history, exactly as before: a
//     merely-plausible top match is exactly the case a follow-up-shaped turn
//     most needs the model's context for.
//   - Multi-question split (matchMultiDirectKb, below): a 2-3-part message
//     where EVERY part near-exact-matches a DIFFERENT stored question is
//     answered with one WhatsApp message per part, still zero model calls.
//     This is independent of the single-question gate above — a multi-part
//     message structurally can never pass isStandaloneQuestionShape (it has
//     more than one '?'), so the two paths never compete for the same
//     message.

import { normalizeHebrew, scoreRow } from './kb-retrieval.js';

// Exported for tests / tuning visibility — these are the exact numbers that
// decide "direct answer" vs "ask the model".
export const DIRECT_MATCH = Object.freeze({
  jaccardThreshold: 0.85, // near-exact: 85%+ of the normalized words agree
  minScoreForMargin: 6,   // at least ~2 full question-word hits (weight 3 each)
  marginRatio: 3,         // and at least 3x the runner-up's score
  maxWords: 25,           // longer than this reads as multi-part, not one question
  minSegments: 2,         // fewer than this isn't a "multi-question" message at all
  maxSegments: 3,         // more than this reads as rambling, not a clean list of asks
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
  if (!isStandaloneQuestionShape(message)) return null;
  if (!rows?.length) return null;

  const messageWordSet = new Set(normalizeHebrew(message));
  if (!messageWordSet.size) return null;

  const scored = rows
    .map((row) => ({ row, score: scoreRow(messageWordSet, row) }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top || top.score === 0) return null;

  // Near-exact wording is strong enough evidence of a self-contained message
  // that it is allowed mid-conversation too — checked, and allowed to
  // return, before the historyNonTrivial gate below.
  if (isNearExactMatch(message, top.row.question)) {
    return { question: top.row.question, answer: top.row.answer };
  }
  if (historyNonTrivial) return null;

  const runnerUpScore = scored[1]?.score ?? 0;
  const overwhelmingMargin = top.score >= DIRECT_MATCH.minScoreForMargin &&
    (runnerUpScore === 0 || top.score / runnerUpScore >= DIRECT_MATCH.marginRatio);

  if (!overwhelmingMargin) return null;
  return { question: top.row.question, answer: top.row.answer };
}

// ── Multi-question split ("both-direct only") ────────────────────────────────
// Segments a message into candidate question parts: split right after every
// '?' (keeping the mark with its part) AND on newlines, trim, drop empties.
// Pure text shaping — no KB awareness here at all.
export function segmentQuestions(message) {
  const text = String(message ?? '');
  if (!text.trim()) return [];
  const segments = [];
  for (const line of text.split(/\r?\n/)) {
    for (const part of line.split(/(?<=\?)/)) {
      const trimmed = part.trim();
      if (trimmed) segments.push(trimmed);
    }
  }
  return segments;
}

// The best row whose QUESTION near-exact-matches this one segment, or null.
// Deliberately reuses the same jaccardThreshold as the single-question path
// — a segment is exactly one question, so it earns no looser bar than one.
function bestNearExactRow(segment, rows) {
  const segWords = normalizeHebrew(segment);
  if (!segWords.length) return null;
  let best = null;
  let bestJaccard = 0;
  for (const row of rows) {
    const j = jaccard(segWords, normalizeHebrew(row?.question));
    if (j >= DIRECT_MATCH.jaccardThreshold && j > bestJaccard) {
      bestJaccard = j;
      best = row;
    }
  }
  return best;
}

// Returns:
//   - null                                — not eligible (wrong segment count,
//                                            no rows, or any segment missed) —
//                                            take the normal COMBINED-message
//                                            model path, never a per-segment
//                                            model call.
//   - { multi: true,  hits: [...] }        — every segment near-exact-matched
//                                            a DIFFERENT row, in order.
//   - { multi: false, question, answer }   — every segment matched, but they
//                                            all landed on the SAME row: this
//                                            is really one question asked
//                                            twice, not a multi-part message —
//                                            collapse to one ordinary direct
//                                            answer instead of repeating it.
export function matchMultiDirectKb({ message, rows }) {
  if (!rows?.length) return null;
  const segments = segmentQuestions(message);
  if (segments.length < DIRECT_MATCH.minSegments || segments.length > DIRECT_MATCH.maxSegments) return null;

  const matchedRows = [];
  for (const segment of segments) {
    const row = bestNearExactRow(segment, rows);
    if (!row) return null; // any miss — fall through entirely, no partial credit
    matchedRows.push(row);
  }

  const distinctRows = new Set(matchedRows);
  if (distinctRows.size === 1) {
    const row = matchedRows[0];
    return { multi: false, question: row.question, answer: row.answer };
  }
  // Every segment landed on a different row: the clean multi-answer case.
  // A partial overlap (2 of 3 share a row, 1 doesn't) is neither this nor the
  // all-same case above — ambiguous which duplicate to drop, so it falls
  // through to the model rather than guess.
  if (distinctRows.size === matchedRows.length) {
    return { multi: true, hits: matchedRows.map((row) => ({ question: row.question, answer: row.answer })) };
  }
  return null;
}
