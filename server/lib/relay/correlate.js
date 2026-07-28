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
//
// The trailing class includes '?' (a rep typing "עצור?" means stop, and it read
// as an answer to be relayed to the lead in the bot's voice) and whitespace, so
// "עצור ." — punctuation after a space — is stripped in one pass rather than
// leaving a trailing space that no token can match.
export function isStopMessage(body) {
  const cleaned = String(body ?? '').trim().replace(/[\s.!,;:?]+$/, '').toLowerCase();
  return STOP_TOKENS.has(cleaned);
}

// openRows must be newest-first.
export function resolveEscalation({ contextId, text, openRows = [] }) {
  const { code, body } = parseRepMessage(text);
  const isStop = isStopMessage(body);
  const out = (row, matchedBy) => ({ row: row ?? null, matchedBy: row ? matchedBy : null, body, isStop });

  // Any message WE sent the rep about this escalation is quote-matchable:
  // rep_message_id is the original notification, rep_message_ids collects the
  // nudges. The nudge is the most recent message in the rep's thread and so the
  // one they are most likely to reply to — without it in the ladder, a natural
  // answer (no leading #N) falls all the way to 'recent' and reaches the wrong
  // lead. rep_message_ids may be absent on rows written before its column
  // existed; Array.isArray covers that.
  if (contextId) {
    const hit = openRows.find(r => r.rep_message_id === contextId
      || (Array.isArray(r.rep_message_ids) && r.rep_message_ids.includes(contextId)));
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
