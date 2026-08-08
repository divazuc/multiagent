// Task 17: a client mid-payment sends a screenshot in WhatsApp. This module
// intercepts that inbound image (called from index.js's 'unsupported' branch,
// before the generic text-only fallback would fire), downloads the media from
// the Graph API, forwards it to the booster — which owns storage, the
// payment_proof_sent transition, and Diva's Telegram alert — and replies with
// the ONE approved acknowledgement phrase.
//
// Spec §אימות התשלום: the bot must never tell the client the payment is
// confirmed ("התשלום אושר") — only Diva's manual review does that. The booster
// side enforces this too (payment_proof_sent is never treated as paid), but
// the bot's own reply text is pinned here so it can never drift.
import { supabase } from './supabase.js';
import { sendWhatsAppMessage } from './wa-send.js';
import * as boosterClientReal from './booster-client.js';

// Test seams — same convention as lib/modules/booster.js / routes/booster-webhook.js:
// production always uses the real implementation, tests inject a stub.
let boosterClient = boosterClientReal;
export function _setBoosterClientForTest(fake) { boosterClient = fake ?? boosterClientReal; }

let sendFn = sendWhatsAppMessage;
export function _setSendForTest(fn) { sendFn = fn ?? sendWhatsAppMessage; }

const GRAPH_API = 'https://graph.facebook.com/v21.0';

// Real Graph media download — two hops: media id -> a short-lived CDN url (+
// mime_type), then the binary itself. Both calls need the SAME bearer token
// used to send messages for this WhatsApp number.
async function downloadMetaMediaReal(mediaId, token) {
  const metaRes = await fetch(`${GRAPH_API}/${mediaId}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!metaRes.ok) throw new Error(`media metadata fetch failed: ${metaRes.status}`);
  const meta = await metaRes.json();
  if (!meta?.url) throw new Error('media metadata missing url');
  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!fileRes.ok) throw new Error(`media download failed: ${fileRes.status}`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return { buffer, mime: meta.mime_type ?? null };
}
let downloadMetaMedia = downloadMetaMediaReal;
export function _setMediaDownloaderForTest(fn) { downloadMetaMedia = fn ?? downloadMetaMediaReal; }

// Same credentials pattern as wa-send.js: a business row's own token, falling
// back to the shared env token. A dedicated seam (rather than stubbing
// supabase.js directly) keeps this module's unit tests DB-free.
async function lookupBusinessCredsReal(phoneNumberId) {
  const { data: biz } = await supabase
    .from('businesses')
    .select('id, wa_access_token')
    .eq('wa_phone_number_id', phoneNumberId)
    .maybeSingle();
  if (!biz) return null;
  const token = biz.wa_access_token ?? process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) return null;
  return { businessId: biz.id, token };
}
let lookupBusinessCreds = lookupBusinessCredsReal;
export function _setBusinessLookupForTest(fn) { lookupBusinessCreds = fn ?? lookupBusinessCredsReal; }

// Spec §5 on the booster side: a proof is only meaningful while awaiting
// payment (or a second proof arriving after the first was already logged).
const PAYMENT_STAGE_STATUSES = new Set(['awaiting_payment', 'payment_proof_sent']);

const ACK_TEXT = 'קיבלתי, בודקת ומעדכנת 🙏';
const FAIL_TEXT = 'אופס, הייתה תקלה בקליטת הצילום 🙈 אפשר לנסות לשלוח שוב, ואם זה נמשך אני אבדוק ידנית.';

// Returns true when this image WAS routed through the payment-proof flow
// (handled here — the caller must NOT also run the generic unsupported-
// message fallback, or the client gets two contradictory replies). Returns
// false for anything that isn't a confirmed payment-stage sender's image —
// the caller's existing behavior (today's fallback) stands untouched.
export async function handlePaymentProofImage(value) {
  const msg = value?.messages?.[0];
  const from = msg?.from;
  const phoneNumberId = value?.metadata?.phone_number_id;
  if (!msg || msg.type !== 'image' || !msg.image?.id || !from || !phoneNumberId) return false;

  let lead = null;
  try {
    lead = await boosterClient.lookupBoosterLeadByPhone(from);
  } catch (e) {
    // Unknown status: never guess a sender into the payment flow — falls
    // through to the generic fallback exactly like a non-payment sender would.
    console.error('[payment-proof] lead lookup failed — treating as non-payment-stage:', e.message);
    return false;
  }
  if (!lead || !PAYMENT_STAGE_STATUSES.has(lead.status)) return false;

  // From here the sender IS a confirmed payment-stage lead — every failure
  // past this point is ours to handle (log + polite reply), never propagated
  // back to the caller, so the client never gets a second, contradictory reply.
  try {
    const creds = await lookupBusinessCreds(phoneNumberId);
    if (!creds) {
      console.error('[payment-proof] no WhatsApp credentials for phone_number_id', phoneNumberId, '— cannot reply');
      return true; // nothing more we can do without a token to send with
    }
    try {
      const { buffer, mime } = await downloadMetaMedia(msg.image.id, creds.token);
      await boosterClient.forwardPaymentProof({
        leadId: lead.leadId,
        imageBase64: buffer.toString('base64'),
        mime: mime || msg.image.mime_type || 'image/jpeg',
        caption: msg.image.caption,
      });
      await sendFn({ to: from, text: ACK_TEXT, businessId: creds.businessId });
    } catch (e) {
      console.error('[payment-proof] forward failed for lead', lead.leadId, ':', e.message);
      await sendFn({ to: from, text: FAIL_TEXT, businessId: creds.businessId }).catch(() => {});
    }
  } catch (e) {
    console.error('[payment-proof] unexpected error handling payment-proof image:', e.message);
  }
  return true;
}
