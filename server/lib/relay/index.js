// Escalation relay: ask a human, then answer the lead in the bot's voice.
import { resolveRep, findContactByPhone } from './contacts.js';
import { normalizePhone } from './phone.js';
import { resolveEscalation } from './correlate.js';
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

// Rewrites the human's answer into the bot's voice WITHOUT passing it through
// validate() or the forbidden-phrase check: the rep IS the business, so their
// answer is authoritative. Content must survive verbatim — only tone changes.
async function voiceRewrite(answer /*, persona */) {
  return answer; // Task 7 replaces this with a model call
}

// Recognises a message from ANY listed contact (rep or owner) — not only the
// resolved rep — so an owner who writes in is never mistaken for a lead and
// sold to. Scoped to the business that owns the receiving number: the lookup
// is by (business.id, from), never a global phone search.
export async function handleContactMessage({ business, from, text, contextId, persona = null }) {
  try {
    const contact = await findContactByPhone(business.id, from);
    if (!contact) return false;

    const open = await store.listOpen(business.id);
    const { row, matchedBy, body, isStop } = resolveEscalation({ contextId, text, openRows: open });

    if (!row) {
      await send({ to: from, text: 'אין כרגע שאלה שממתינה לתשובה.', businessId: business.id });
      return true;
    }

    if (isStop) {
      await store.markStopped(row.id);
      await send({ to: from, text: `הופסק ✓ (${row.session_id})`, businessId: business.id });
      return true;
    }

    const reply = await voiceRewrite(body, persona);
    await send({ to: row.session_id, text: reply, businessId: business.id });
    await store.markAnswered(row.id, body);

    // When we had to guess, name the thread so a mis-route is visible at once.
    const ack = matchedBy === 'recent' ? `נשלח ✓ (${row.session_id})` : 'נשלח ✓';
    await send({ to: from, text: ack, businessId: business.id });
    return true;
  } catch (e) {
    console.error('[relay] contact message failed:', e.message);
    return false;
  }
}
