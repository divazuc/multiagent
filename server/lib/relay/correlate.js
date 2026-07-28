// Matching a rep's WhatsApp message to the escalation it answers. The rep has
// ONE thread with the bot, so several leads can be waiting at once.
export const STOP_TOKENS = new Set(['עצור', 'די', 'הפסק', 'הפסיק', 'stop']);

export function parseRepMessage(text) {
  const raw = String(text ?? '').trim();
  const m = raw.match(/^#(\d{1,3})\b[\s.,:;-]*/);
  if (!m) return { code: null, body: raw };
  return { code: Number(m[1]), body: raw.slice(m[0].length).trim() };
}

// Whole-message match only. "די יקר, אבל אפשר לפרוס" is an ANSWER, not a stop.
export function isStopMessage(body) {
  const cleaned = String(body ?? '').trim().replace(/[.!,;:]+$/, '').toLowerCase();
  return STOP_TOKENS.has(cleaned);
}

// openRows must be newest-first.
export function resolveEscalation({ contextId, text, openRows = [] }) {
  const { code, body } = parseRepMessage(text);
  const isStop = isStopMessage(body);
  const out = (row, matchedBy) => ({ row: row ?? null, matchedBy: row ? matchedBy : null, body, isStop });

  if (contextId) {
    const hit = openRows.find(r => r.rep_message_id === contextId);
    if (hit) return out(hit, 'quote');
  }
  if (code != null) {
    const hit = openRows.find(r => r.short_code === code);
    if (hit) return out(hit, 'code');
  }
  if (openRows.length === 1) return out(openRows[0], 'single');
  if (openRows.length > 1) return out(openRows[0], 'recent');
  return out(null, null);
}
