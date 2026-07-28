// Where a contact sits in the lead pipeline, and when the pipeline may move it.
//
// The rule that matters: automatic progression must never erase a status a
// human chose. The previous inline version compared with
// `statusOrder.indexOf(existing)`, which returns -1 for anything off the
// ladder — so every automatic status compared greater and overwrote it.
// Production had 9 of 14 contacts holding off-ladder values, including three
// the client had marked "closed" via the סמן כטופל button; each was reset to
// in_conversation the next time that lead sent a message.

export const STATUS_ORDER = [
  'new_lead', 'in_conversation', 'cta_triggered', 'meeting_booked',
  'followup_sent', 'converted', 'cold', 'not_relevant',
];

// Values that plainly mean a ladder status and predate it.
const ALIASES = { new: 'new_lead' };

const normalize = (s) => ALIASES[s] ?? s;

/**
 * The status to write, or null to leave the contact alone.
 * Off-ladder values are treated as deliberate human marks and are preserved.
 */
export function nextStatus(existing, incoming) {
  if (!incoming) return null;

  const to = STATUS_ORDER.indexOf(normalize(incoming));
  if (to === -1) return null; // never write a status the pipeline does not know

  if (!existing) return incoming;

  const from = STATUS_ORDER.indexOf(normalize(existing));
  if (from === -1) return null; // a manual or legacy mark — not ours to overwrite

  return to > from ? incoming : null;
}
