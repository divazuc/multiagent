// WA_01 replacement — extract message + session_id from any inbound payload

export function normalizeMessage(data) {
  try {
    // WhatsApp Cloud API format
    if (data?.object === 'whatsapp_business_account') {
      const msg = data.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msg) return err('No message found in Cloud API payload');

      const text = msg.type === 'interactive'
        ? msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title
        : msg.type === 'button' // quick-reply tap on a template message
          ? msg.button?.text
          : msg.text?.body;

      const session_id     = data.entry[0].changes[0].value.contacts?.[0]?.wa_id ?? msg.from;
      const phone_number_id = data.entry[0].changes[0].value.metadata?.phone_number_id ?? null;

      return validate(text, session_id, phone_number_id);
    }

    // Direct format: { message, session_id }
    if (data?.message !== undefined && data?.session_id !== undefined) {
      return validate(data.message, data.session_id);
    }

    return err('Unrecognised payload format');
  } catch (e) {
    return err(`Parse error: ${e.message}`);
  }
}

function validate(message, session_id, phone_number_id = null) {
  const m = String(message ?? '').trim();
  const s = String(session_id ?? '').trim();
  if (!m) return err('Empty message');
  if (!s) return err('Empty session_id');
  return { status: 'success', result: { message: m, session_id: s, phone_number_id }, error: null };
}

function err(msg) {
  return { status: 'error', result: {}, error: msg };
}
