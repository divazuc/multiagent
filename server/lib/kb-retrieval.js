// Cost-efficiency pass (2026-08-12): agents/conversation.js used to dump the
// ENTIRE ~45-row knowledge.faq_summary text blob into the system prompt on
// EVERY message. This module replaces that with a small, per-turn retrieval
// pass over the business's knowledge_items rows (business_profile.knowledge.
// items — lib/context.js) — normalized-Hebrew keyword overlap, top K rows
// only. Pure and DB-free on purpose: conversation.js decides what to do with
// an empty result (its fallback to the full faq_summary text — see
// buildKbContext there); this file only scores and formats.
//
// lib/kb-direct-match.js (item 4, no-model-call FAQ answers) reuses
// normalizeHebrew + scoreRow from here rather than re-implementing scoring.

const DEFAULT_TOP_K = 8;

// Weights: a message word landing in the STORED QUESTION is much stronger
// signal than landing in the answer (an answer can be long and generic;
// two people can ask very different questions that happen to get answered
// with overlapping text). Category is a small flat bonus, not per-word — a
// category is usually one or two words ("pricing", "booking"), so any hit at
// all is the signal, not how many of its words matched.
const QUESTION_WORD_WEIGHT = 3;
const ANSWER_WORD_WEIGHT = 1;
const CATEGORY_BONUS = 2;

// Hebrew cantillation marks + niqqud (vowel points) — U+0591-U+05C7. Stripped
// before splitting so "שָׁלוֹם" and "שלום" score identically; almost no
// business FAQ content is written with niqqud, but customer messages
// occasionally carry it from autocomplete/voice-to-text.
const NIKUD_RE = /[֑-ׇ]/g;
// Anything that isn't a letter, digit, or whitespace (any Unicode script —
// this runs on mixed Hebrew/English text) becomes a split point.
const PUNCT_RE = /[^\p{L}\p{N}\s]/gu;

export function normalizeHebrew(text) {
  return String(text ?? '')
    .replace(NIKUD_RE, '')
    .replace(PUNCT_RE, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function wordSet(text) {
  return new Set(normalizeHebrew(text));
}

function overlapCount(needles, haystack) {
  let n = 0;
  for (const w of needles) if (haystack.has(w)) n++;
  return n;
}

// Exported so kb-direct-match.js can score the same rows without
// re-normalizing the message itself for every row.
export function scoreRow(messageWordSet, row) {
  if (!messageWordSet.size) return 0;
  const qHits = overlapCount(messageWordSet, wordSet(row?.question));
  const aHits = overlapCount(messageWordSet, wordSet(row?.answer));
  const cHits = overlapCount(messageWordSet, wordSet(row?.category));
  return qHits * QUESTION_WORD_WEIGHT + aHits * ANSWER_WORD_WEIGHT + (cHits > 0 ? CATEGORY_BONUS : 0);
}

// Returns the top K rows (default 8) scored against the message, each as
// { row, score }, highest score first. Rows that score 0 (no overlap at all)
// are dropped — a non-match is not "weakly relevant", it's irrelevant, and
// keeping it would just add noise (and tokens) to the prompt.
export function retrieveTopK({ message, rows, topK = DEFAULT_TOP_K }) {
  const messageWordSet = wordSet(message);
  if (!rows?.length || !messageWordSet.size) return [];
  return rows
    .map((row) => ({ row, score: scoreRow(messageWordSet, row) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// The compact context block conversation.js puts in the DYNAMIC tail (never
// the cached stable prefix — see item 2's cache_control placement). Carries
// its own one-line anti-hallucination guard next to the retrieved rows,
// distinct from the always-present GROUNDING_RULE in the stable block.
export function formatKbContextBlock(scored) {
  if (!scored?.length) return '';
  const lines = scored.map(({ row }) => `Q: ${row.question}\nA: ${row.answer}`).join('\n\n');
  return `Relevant knowledge for this question:\n${lines}\n\nאם אין במידע תשובה — אל תמציא.`;
}

// ── Core facts (owner incident 2026-08-13) ────────────────────────────────────
// Word-overlap retrieval has a blind spot: facts a customer needs that share
// no words with what they typed ("רועי בן 7" needs the schedule; "מתי מתקיים
// החוג" needs the trial-form link the answer should end with). Rows the owner
// marks with the 'core' archetype are exempt from retrieval entirely: they
// ride in the STABLE (cached) system block, always visible, ~free after the
// first turn. splitCoreRows partitions once per turn; retrieval then runs
// only over the rest so a core row never occupies a top-K slot too.
export function splitCoreRows(rows) {
  const core = [], rest = [];
  for (const row of rows ?? []) {
    (Array.isArray(row?.archetypes) && row.archetypes.includes('core') ? core : rest).push(row);
  }
  return { core, rest };
}

export function formatCoreKbBlock(core) {
  if (!core?.length) return '';
  const lines = core.map((row) => `Q: ${row.question}\nA: ${row.answer}`).join('\n\n');
  return `Core business facts (always applicable — use these whenever relevant, e.g. schedule, pricing, and the trial signup link):\n${lines}`;
}
