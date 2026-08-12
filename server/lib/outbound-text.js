// Deterministic cleanup of MODEL-settled outbound text, applied platform-wide
// right where the final reply text leaves the model (agents/conversation.js
// callClaude + rewrite, lib/relay voiceRewrite) — the same convention as the
// ```json fence-stripping the JSON-returning calls already do.
//
// Live pilot, 2026-08-12: the model sometimes wraps the WHOLE reply in
// quotation marks — a perfect answer delivered as "…text…". A prompt rule
// (NO_QUOTE_WRAP in agents/conversation.js) asks it not to; this strips it
// when it does anyway.
//
// Rule: if the final TRIMMED text starts and ends with a MATCHING wrapping
// pair, strip exactly one outer pair. Never touch quotes inside the text, a
// lone leading/trailing quote, or a mismatched pair.

const WRAP_PAIRS = new Map([
  ['"', ['"']],          // straight doubles
  ["'", ["'"]],          // straight singles
  ['“', ['”']], // “…”
  ['”', ['“']], // ”…“ (the reversed style some models emit)
  ['„', ['“', '”']], // „…“ / „…”
  ['«', ['»']], // «…»
  ['״', ['״']], // ״…״ Hebrew gershayim used as quotes
]);

export function stripWrappingQuotes(text) {
  const s = String(text ?? '').trim();
  if (s.length < 2) return s;
  const closers = WRAP_PAIRS.get(s[0]);
  if (!closers || !closers.includes(s[s.length - 1])) return s;
  return s.slice(1, -1).trim();
}
