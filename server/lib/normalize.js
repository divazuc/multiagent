// WA_01 replacement — extract message + session_id from any inbound payload

// Shared with the relay wiring (server/index.js) so a rep's button/interactive
// tap is read the same way a lead's is — text/interactive/button are all
// `kind:'message'` per classifyMetaPayload, but each type stores its text in
// a different place. Always returns a string (never undefined) so a caller
// can safely check for "" without an extra String(...) ?? '' step.
export function extractMessageText(msg) {
  const raw = msg?.type === 'interactive'
    ? msg?.interactive?.button_reply?.title ?? msg?.interactive?.list_reply?.title
    : msg?.type === 'button' // quick-reply tap on a template message
      ? msg?.button?.text
      : msg?.text?.body;
  return raw ?? '';
}

export function normalizeMessage(data) {
  try {
    // WhatsApp Cloud API format
    if (data?.object === 'whatsapp_business_account') {
      const msg = data.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msg) return err('No message found in Cloud API payload');

      const text = extractMessageText(msg);

      const contact         = data.entry[0].changes[0].value.contacts?.[0];
      const session_id      = contact?.wa_id ?? msg.from;
      const phone_number_id = data.entry[0].changes[0].value.metadata?.phone_number_id ?? null;

      return validate(text, session_id, phone_number_id, contact?.profile?.name);
    }

    // Direct format: { message, session_id } — Studio's own sender, no WhatsApp
    // profile behind it, so profile_name is null rather than invented.
    if (data?.message !== undefined && data?.session_id !== undefined) {
      return validate(data.message, data.session_id);
    }

    return err('Unrecognised payload format');
  } catch (e) {
    return err(`Parse error: ${e.message}`);
  }
}

// The WhatsApp display name the sender chose for themselves. It rides the same
// channel as the phone — from the webhook, never from the model — and lets a
// module name a lead without the bot interrogating the customer for it in chat
// (lib/modules/booster.js, create_quote_lead).
//
// It is CUSTOMER-CONTROLLED text, so it is trimmed, capped and normalised to
// null when it carries nothing usable: downstream it is written to a booster
// lead, and an absent name must read as absent so the booster's own default
// applies rather than an empty string overwriting it.
const PROFILE_NAME_MAX = 80;
function cleanProfileName(raw) {
  const n = String(raw ?? '').replace(/\s+/g, ' ').trim();
  return n ? n.slice(0, PROFILE_NAME_MAX) : null;
}

function validate(message, session_id, phone_number_id = null, profile_name = null) {
  const m = String(message ?? '').trim();
  const s = String(session_id ?? '').trim();
  if (!m) return err('Empty message');
  if (!s) return err('Empty session_id');
  return {
    status: 'success',
    result: { message: m, session_id: s, phone_number_id, profile_name: cleanProfileName(profile_name) },
    error: null,
  };
}

function err(msg) {
  return { status: 'error', result: {}, error: msg };
}
