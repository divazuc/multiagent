import { supabase } from './supabase.js';

const GRAPH_API = 'https://graph.facebook.com/v21.0';

export async function sendWhatsAppMessage({ to, text, businessId }) {
  try {
    const { data: biz } = await supabase
      .from('businesses')
      .select('wa_phone_number_id, wa_access_token')
      .eq('id', businessId)
      .maybeSingle();

    const phoneNumberId = biz?.wa_phone_number_id ?? process.env.WHATSAPP_PHONE_NUMBER_ID;
    const token         = biz?.wa_access_token     ?? process.env.WHATSAPP_ACCESS_TOKEN;

    if (!phoneNumberId || !token) {
      console.error('[wa-send] missing credentials for business', businessId);
      return;
    }

    const res = await fetch(`${GRAPH_API}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to,
        type: 'text',
        text: { body: text },
      }),
    });

    const data = await res.json();
    if (!res.ok) console.error('[wa-send] API error:', JSON.stringify(data));
    return data;
  } catch (e) {
    console.error('[wa-send] fetch error:', e.message);
  }
}

// Template send — required for business-initiated messages outside the
// 24-hour customer-service window (e.g. follow-ups). The template must be
// approved in WhatsApp Manager; bodyParams fill {{1}}, {{2}}… in order.
export async function sendWhatsAppTemplate({ to, templateName, langCode = 'he', bodyParams = [], businessId }) {
  try {
    const { data: biz } = await supabase
      .from('businesses')
      .select('wa_phone_number_id, wa_access_token')
      .eq('id', businessId)
      .maybeSingle();

    const phoneNumberId = biz?.wa_phone_number_id ?? process.env.WHATSAPP_PHONE_NUMBER_ID;
    const token         = biz?.wa_access_token     ?? process.env.WHATSAPP_ACCESS_TOKEN;

    if (!phoneNumberId || !token || !templateName) {
      console.error('[wa-send] missing template credentials/name for business', businessId);
      return;
    }

    const template = { name: templateName, language: { code: langCode } };
    if (bodyParams.length) {
      template.components = [{
        type: 'body',
        parameters: bodyParams.map(text => ({ type: 'text', text: String(text) })),
      }];
    }

    const res = await fetch(`${GRAPH_API}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to,
        type: 'template',
        template,
      }),
    });

    const data = await res.json();
    if (!res.ok) console.error('[wa-send] template API error:', JSON.stringify(data));
    return data;
  } catch (e) {
    console.error('[wa-send] template fetch error:', e.message);
  }
}
