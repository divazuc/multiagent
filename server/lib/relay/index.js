// Escalation relay: ask a human, then answer the lead in the bot's voice.
import { resolveRep } from './contacts.js';
import { normalizePhone } from './phone.js';
import * as store from './store.js';

let sender = null; // test seam
export function _setSenderForTest(fn) { sender = fn; }

// Test seam for the business's own record (currently only whatsapp_number,
// used by the own-number guard below). Same lazy-import style as
// contacts.js/store.js — never import supabase at module top level.
let db = null;
export function _setDbForTest(fake) { db = fake; }

async function realDb() {
  const { supabase } = await import('../supabase.js');
  return {
    async getBusiness(businessId) {
      const { data, error } = await supabase.from('businesses')
        .select('whatsapp_number').eq('id', businessId).maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
  };
}

const getDb = async () => db ?? await realDb();

async function send(msg) {
  if (sender) return sender(msg);
  const { sendWhatsAppMessage } = await import('../wa-send.js');
  return sendWhatsAppMessage(msg);
}

function holdingLineFor(persona) {
  return persona?.bot_gender === 'male'
    ? 'אני צריך לבדוק את זה, אעדכן בקרוב.'
    : 'אני צריכה לבדוק את זה, אעדכן בקרוב.';
}

function repMessage({ code, leadName, summary, question }) {
  const who = leadName ? ` · ${leadName}` : '';
  const ctx = summary ? `\nסיכום: ${summary}` : '';
  return `#${code}${who}${ctx}\nהשאלה: ${question}\n\nענו להודעה הזו (Reply) כדי שאעביר את התשובה.`;
}

// Returns null when no relay is possible — the caller then keeps today's
// behaviour. NEVER tell a lead we are checking if nobody was asked.
export async function raiseEscalation({ business, session_id, question, reason = null, summary = null, leadName = null, persona = {} }) {
  try {
    const rep = await resolveRep(business.id);
    if (!rep) return null;

    // Guard: the owner-contact backfill copied business_profiles.contact_phone
    // into the owner contact row, and for two real businesses that column
    // holds the business's own WABA number. If the resolved rep is that same
    // number, refuse to send — a later task treats messages from a listed
    // contact as a rep reply, so messaging ourselves could turn into the bot
    // talking to itself. Compare normalized so '054-...' vs '972...' can't
    // slip past.
    const biz = await (await getDb()).getBusiness(business.id);
    const repPhone = normalizePhone(rep.phone);
    const bizPhone = normalizePhone(biz?.whatsapp_number);
    if (repPhone && bizPhone && repPhone === bizPhone) {
      console.error(`[relay] refusing to escalate: resolved rep phone equals business's own WhatsApp number (business=${business.id})`);
      return null;
    }

    const code = await store.nextShortCode(business.id);
    const res = await send({
      to: rep.phone,
      text: repMessage({ code, leadName, summary, question }),
      businessId: business.id,
    });
    const repMessageId = res?.messages?.[0]?.id ?? null;
    if (!repMessageId) return null;

    await store.createEscalation({
      business_id: business.id, session_id, short_code: code,
      question, reason, summary, rep_phone: rep.phone,
      rep_message_id: repMessageId, status: 'open',
      created_at: new Date().toISOString(),
    });

    return { holdingLine: holdingLineFor(persona) };
  } catch (e) {
    console.error('[relay] raise failed:', e.message);
    return null;
  }
}
