// How long to wait before sending a reply, so the bot reads as a person typing
// rather than a machine answering in 200ms.
//
// The window is the TOTAL time the lead waits, measured from when their message
// arrived — not an extra pause bolted onto generation. The previous version
// slept 3-5s after the model returned, so a 7-second generation felt like 12,
// and a slow one felt broken. Now a slow generation simply consumes the budget
// and nothing is added.

export const DELAY_WINDOWS = {
  short:    [4000, 9000],
  medium:   [6000, 11000],
  detailed: [8000, 14000],
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
