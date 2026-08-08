import express from 'express';
import crypto from 'node:crypto';
import { sendWhatsAppMessage } from '../lib/wa-send.js';
import { boosterMessageFor, toWaNumber } from '../lib/booster-messages.js';

const router = express.Router();

// At-least-once delivery from the booster's outbox → in-memory dedup by
// event_id (bounded). Survives normal operation; a restart may re-send at
// most one 10-minute batch — accepted for v1 (documented in the plan).
// An event_id is only ever remembered once it is either delivered or
// legitimately skipped (malformed/unroutable) — a FAILED send must never be
// remembered, or the booster's outbox would mark it 'sent' while the client
// silently got nothing.
const seen = new Set();
const remember = (id) => { seen.add(id); if (seen.size > 1000) seen.delete(seen.values().next().value); };

// Test seam — production always sends through the real Graph client; tests
// inject a stub so success/failure/timeout can be simulated without a
// network call. Keeps the default wiring (index.js -> this router) untouched.
let sendFn = sendWhatsAppMessage;
export const _setSendForTest = (fn) => { sendFn = fn ?? sendWhatsAppMessage; };

// Same pattern as lib/auth.js's ADMIN_API_KEY check: constant-time compare,
// length pre-checked first because timingSafeEqual throws on a length
// mismatch rather than returning false.
function bearerOk(req) {
  const key = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const expected = process.env.BOT_WEBHOOK_SECRET ?? '';
  try {
    return !!(expected && key.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected)));
  } catch {
    return false; // length mismatch
  }
}

// The booster expects a 2xx within 8s and retries otherwise, so a send that
// hangs must not hold the response open past that SLA. 6s leaves headroom
// for the response itself to reach the booster inside its 8s budget.
const SEND_TIMEOUT_MS = 6000;
const TIMED_OUT = Symbol('booster-webhook-send-timeout');
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

router.post('/booster-webhook', async (req, res) => {
  if (!bearerOk(req)) {
    return res.status(401).json({ ok: false });
  }
  const { event_id, event, payload, lead } = req.body ?? {};
  if (!event_id || !event) return res.status(400).json({ ok: false, error: 'bad_shape' });
  if (seen.has(event_id)) return res.json({ ok: true, deduped: true });

  const text = boosterMessageFor(event, payload, lead);
  const to = toWaNumber(lead?.phone);
  if (!text || !to || to.length < 11) {
    console.warn('[booster-webhook] skipped event', event, event_id, 'to:', to);
    remember(event_id);
    return res.json({ ok: true, skipped: true }); // ack — a malformed event must not retry forever
  }

  // wa-send.js deliberately never rejects (other call sites rely on that
  // never-throw contract), so a try/catch around the call cannot detect
  // failure — it resolves the Graph response on success, and resolves
  // undefined or an {error} body on any failure (missing credentials, a
  // rejected/expired token, a Supabase lookup failure, or Meta bouncing the
  // message). Success must therefore be read from the RESULT shape: Graph's
  // success response is always {messages:[{id, ...}]}. A 24h-messaging-window
  // rejection lands in this same failure path deliberately — a business-
  // initiated reminder/expiry notice Meta bounces must surface in the
  // booster's outbox as failed, not vanish behind a false 200.
  let result;
  try {
    result = await withTimeout(
      sendFn({ to, text, businessId: process.env.DIVAZ_BUSINESS_ID ?? null }),
      SEND_TIMEOUT_MS,
    );
  } catch (e) {
    console.error('[booster-webhook] send threw unexpectedly', event_id, e.message);
    result = null;
  }

  const timedOut = result === TIMED_OUT;
  const ok = !timedOut && !!result?.messages?.length;
  if (!ok) {
    console.error('[booster-webhook] send failed', event_id,
      timedOut ? 'timeout' : JSON.stringify(result ?? null));
    return res.status(502).json({ ok: false }); // booster retries (≤5 attempts) — event_id intentionally NOT remembered
  }

  remember(event_id);
  return res.json({ ok: true });
});

export default router;
