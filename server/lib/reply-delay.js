// How long to wait before sending a reply, so the bot reads as a person typing
// rather than a machine answering in 200ms.
//
// The window is the TOTAL time the lead waits, measured from when their message
// arrived — not an extra pause bolted onto generation. The previous version
// slept 3-5s after the model returned, so a 7-second generation felt like 12,
// and a slow one felt broken. Now a slow generation simply consumes the budget
// and nothing is added.

// Owner, after her live demo: "תעדכן את זמן התגובה בין הודעות בוואטסאפ כ3-4
// שניות, לא יותר". The bands used to run 4-14s, which felt considered in
// testing and felt like being ignored in front of a customer.
//
// 4000ms is a ceiling, not a target. The bands still differ from one another —
// a one-line answer landing at the same beat as a long one is its own tell —
// but the whole ladder now fits inside her window, and the randomness inside
// each band is what keeps the rhythm from sounding metronomic.
export const DELAY_WINDOWS = {
  short:    [3000, 3600],
  medium:   [3200, 3800],
  detailed: [3400, 4000],
};

function bandFor(words, answerLength) {
  if (answerLength === 'detailed' || words > 40) return 'detailed';
  if (answerLength === 'medium' || words > 20) return 'medium';
  return 'short';
}

/** Milliseconds still to wait. Zero when generation already used the budget. */
export function replyDelayMs({ words = 0, answerLength = 'short', elapsedMs = 0, random = Math.random }) {
  const [min, max] = DELAY_WINDOWS[bandFor(words, answerLength)] ?? DELAY_WINDOWS.short;
  const target = min + random() * (max - min);
  return Math.max(0, Math.round(target) - (Number(elapsedMs) || 0));
}
