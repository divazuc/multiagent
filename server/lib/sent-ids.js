// Ring of OUR OWN outbound WhatsApp message ids (Graph API `messages[0].id`).
//
// Why it exists (coexistence pilot, 2026-08-12): on a coexistence number Meta
// echoes EVERY outbound message back to the webhook — including messages this
// server itself sent through the Cloud API (replies, after-hours notes, trial
// reminders, follow-up templates). An echo of our own send is NOT the owner
// personally answering: it must not arm the owner standdown and must not
// advance the lead board to 'contacted' (live pilot: the owner's own lead row
// got auto-'contacted' by our test-reminder sends).
//
// wa-send.js records every id the Graph API returns; lib/coexistence.js checks
// an incoming echo's id against the ring and classifies a hit as `self_send`.
//
// In-memory on purpose — same posture as the webhook message-id dedup in
// lib/wa-webhook.js: a single Railway instance, and a miss after a restart
// merely restores today's behaviour (the echo is treated as an owner echo).
// Bounded by count AND age so it can never grow with traffic.

const MAX_IDS = 200;
const TTL_MS = 10 * 60 * 1000; // 10 minutes — echoes arrive within seconds

const ring = new Map(); // id -> recorded-at epoch ms (Map preserves insertion order)

export function recordSentMessageId(id) {
  if (!id) return;
  ring.delete(id); // re-recording refreshes the position and timestamp
  ring.set(id, Date.now());
  while (ring.size > MAX_IDS) {
    ring.delete(ring.keys().next().value); // oldest first
  }
}

export function isSelfSendId(id, nowMs = Date.now()) {
  if (!id) return false;
  const ts = ring.get(id);
  if (ts === undefined) return false;
  if (nowMs - ts > TTL_MS) {
    ring.delete(id);
    return false;
  }
  return true;
}

export function _clearSentIdsForTest() { ring.clear(); }
