// Meta webhook hardening: signature validation, payload classification,
// message-id dedup, and the unsupported-message fallback.

import crypto from 'node:crypto';
import { supabase } from './supabase.js';
import { sendWhatsAppMessage } from './wa-send.js';
import { detectEcho } from './coexistence.js';

// ── X-Hub-Signature-256 ──────────────────────────────────────────────────────
// Validates only when WHATSAPP_APP_SECRET is configured, so the studio and
// local dev keep working without it. Requires req.rawBody (see express.json
// verify hook in index.js).
let warnedNoSecret = false;

export function verifyMetaSignature(req) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) {
    if (!warnedNoSecret) {
      console.warn('[wa-webhook] WHATSAPP_APP_SECRET not set — skipping signature validation');
      warnedNoSecret = true;
    }
    return true;
  }
  const header = req.headers['x-hub-signature-256'];
  if (!header || !req.rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch {
    return false; // length mismatch
  }
}

// ── Payload classification ───────────────────────────────────────────────────
// 'echo'        → the business's OWN message (WhatsApp Coexistence smb echo) —
//                 never a customer message; may trigger the owner standdown
// 'message'     → a user message the pipeline should answer (text/interactive/button)
// 'unsupported' → a user message in a type we don't handle (media, location…)
// 'ignore'      → statuses, history sync, anything else — ack silently
//
// Echo detection runs FIRST: one of Meta's echo shapes rides the ordinary
// `messages` field with the business's own number as the sender, and letting
// it fall through to 'message' would run the reply pipeline against the
// owner's own words (see lib/coexistence.js).
const SUPPORTED_TYPES = new Set(['text', 'interactive', 'button']);

export function classifyMetaPayload(body) {
  const value = body?.entry?.[0]?.changes?.[0]?.value;
  const echo = detectEcho(body);
  if (echo) return { kind: 'echo', msgId: echo.msgId, value, echo };
  const msg = value?.messages?.[0];
  if (msg) {
    return SUPPORTED_TYPES.has(msg.type)
      ? { kind: 'message', msgId: msg.id ?? null, value }
      : { kind: 'unsupported', msgId: msg.id ?? null, value, msgType: msg.type };
  }
  return { kind: 'ignore', value };
}

// ── Message-id dedup ─────────────────────────────────────────────────────────
// Meta retries webhooks that respond slowly or non-200; retries carry the same
// message id. In-memory cache is enough for a single Railway instance.
const SEEN_TTL_MS = 15 * 60 * 1000;
const SEEN_MAX = 2000;
const seen = new Map(); // id -> timestamp

export function seenMessage(id) {
  if (!id) return false;
  const now = Date.now();
  if (seen.has(id)) return true;
  seen.set(id, now);
  if (seen.size > SEEN_MAX) {
    for (const [k, ts] of seen) {
      if (now - ts > SEEN_TTL_MS || seen.size > SEEN_MAX) seen.delete(k);
      else break; // Map preserves insertion order — the rest are newer
    }
  }
  return false;
}

// ── Unsupported-type fallback ────────────────────────────────────────────────
// Polite one-liner so a voice note / image doesn't dead-end the lead.
const FALLBACK_TEXT =
  'סליחה, כרגע אני יודעת לענות רק להודעות טקסט 🤍 אפשר לכתוב לי במילים — או להשאיר שם וטלפון ונציגה תחזור אליכם.';

export async function sendUnsupportedFallback(value) {
  try {
    const from = value?.messages?.[0]?.from;
    const phoneNumberId = value?.metadata?.phone_number_id;
    if (!from || !phoneNumberId) return;
    const { data: biz } = await supabase
      .from('businesses')
      .select('id')
      .eq('wa_phone_number_id', phoneNumberId)
      .maybeSingle();
    if (!biz) return;
    await sendWhatsAppMessage({ to: from, text: FALLBACK_TEXT, businessId: biz.id });
  } catch (e) {
    console.error('[wa-webhook] fallback send failed:', e.message);
  }
}
