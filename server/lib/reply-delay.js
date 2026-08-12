// How long to wait before sending a reply, so the bot reads as a person typing
// rather than a machine answering in 200ms.
//
// The window is the TOTAL time the lead waits, measured from when their message
// arrived — not an extra pause bolted onto generation. The previous version
// slept 3-5s after the model returned, so a 7-second generation felt like 12,
// and a slow one felt broken. Now a slow generation simply consumes the budget
// and nothing is added.

// Owner, kids pilot 2026-08-12: "תקצר את זמן ההמתנה למענה ל4-6 שניות לא
// יותר" — 6000ms is the ceiling of the TOTAL wait this module controls.
// (Supersedes the earlier 3-4s window from the Divaz demo.) A generation
// slower than the band still goes out the moment it is ready — nothing is
// ever added on top — so the only waits above 6s are answers the model
// itself took longer to compose.
//
// The bands still differ from one another — a one-line answer landing at the
// same beat as a long one is its own tell — and the randomness inside each
// band keeps the rhythm from sounding metronomic.
export const DELAY_WINDOWS = {
  short:    [4000, 4700],
  medium:   [4400, 5300],
  detailed: [4800, 6000],
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
