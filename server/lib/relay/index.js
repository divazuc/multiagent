// Escalation relay: ask a human, then answer the lead in the bot's voice.
import { resolveRep, findContactByPhone } from './contacts.js';
import { normalizePhone } from './phone.js';
import { resolveEscalation } from './correlate.js';
import * as store from './store.js';

let sender = null; // test seam
export function _setSenderForTest(fn) { sender = fn; }

// Test seam for the business's own record (whatsapp_number, used by the
// own-number guard below) and the lead's session (qualification_progress,
// used by recordHistory below so a relayed answer doesn't blank it). Same
// lazy-import style as contacts.js/store.js — never import supabase at
// module top level.
let db = null;
export function _setDbForTest(fake) { db = fake; }

// Test seam for persisting the relayed exchange into conversation history
// (server/lib/db.js#saveConversation). Same lazy-import discipline as
// everywhere else in this file — db.js imports supabase.js at module top
// level, which throws when SUPABASE_URL/SERVICE_KEY aren't set, so tests
// must be able to stub this rather than hit the real thing.
let historySaver = null;
export function _setHistorySaverForTest(fn) { historySaver = fn; }

async function realDb() {
  const { supabase } = await import('../supabase.js');
  return {
    async getBusiness(businessId) {
      const { data, error } = await supabase.from('businesses')
        .select('whatsapp_number').eq('id', businessId).maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
    async getSession(sessionId) {
      const { data, error } = await supabase.from('sessions')
        .select('qualification_progress').eq('session_id', sessionId).maybeSingle();
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

// Test seam for the rewrite call — same lazy-import discipline as the rest of
// this file (contacts.js/store.js/db.js): the Anthropic SDK is imported inside
// voiceRewrite, never at module top level, so relay tests keep running with
// no ANTHROPIC_API_KEY set at all.
let rewriter = null;
export function _setRewriterForTest(fn) { rewriter = fn; }

const REWRITE_PROMPT = `אתה מנסח מחדש תשובה של בעל העסק כך שתישמע בקול של הבוט.
חוקים מוחלטים:
- אל תשנה, תוסיף או תוריד שום עובדה, מספר, מחיר, תאריך או שם.
- אל תרכך ואל תסייג. התשובה של בעל העסק היא הקובעת.
- שמור על אורך דומה, בעברית, בגוף ראשון.
החזר את הטקסט בלבד.`;

// Rewrites the human's answer into the bot's voice WITHOUT passing it through
// validate() or the forbidden-phrase check (conversation.js): the rep IS the
// business, so their answer is authoritative. Content must survive verbatim —
// only tone/gender/length may change. Fails soft: any error here, at any
// step, returns the raw answer — the rep's actual words always beat silence.
async function voiceRewrite(answer, persona) {
  if (rewriter) return rewriter(answer, persona);
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const gender = persona?.bot_gender === 'male' ? 'זכר' : 'נקבה';
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: `${REWRITE_PROMPT}\nמגדר הבוט: ${gender}\n\nהתשובה:\n${answer}` }],
    });
    return res.content?.[0]?.text?.trim() || answer;
  } catch (e) {
    console.error('[relay] rewrite failed, sending the raw answer:', e.message);
    return answer; // the human's words are always better than nothing
  }
}

// Records the relayed exchange in the bot's own conversation history so a
// later turn sees what the lead was actually told, instead of a gap where
// the holding line was the last thing said. Best-effort bookkeeping: this
// runs AFTER the answer is confirmed delivered and the row is marked, so a
// failure here must never undo (or be allowed to look like it undoes) work
// that already happened — log and swallow.
//
// saveConversation (db.js — shared with the main pipeline, not modified
// here) writes `qualification_progress ?? {}` into the session row on every
// call. If we didn't read the session's CURRENT progress and pass it back
// through unchanged, every relayed answer would blank whatever the bot had
// already learned about the lead (need/scope/budget/timeline/urgency), and
// the next turn would re-ask for all of it right after a human just helped.
async function recordHistory({ business, row, reply }) {
  try {
    const session = await (await getDb()).getSession(row.session_id);
    const save = historySaver ?? (await import('../db.js')).saveConversation;
    const result = await save({
      session_id: row.session_id,
      business_id: business.id,
      user_message: row.question,
      agent_response: reply,
      stage: 'escalation_answered',
      escalate: false,
      escalation_reason: null,
      qualification_progress: session?.qualification_progress ?? {},
    });
    if (result?.status === 'error') console.error('[relay] history save failed:', result.error);
  } catch (e) {
    console.error('[relay] history save failed:', e.message);
  }
}

// Recognises a message from ANY listed contact (rep or owner) — not only the
// resolved rep — so an owner who writes in is never mistaken for a lead and
// sold to. Scoped to the business that owns the receiving number: the lookup
// is by (business.id, from), never a global phone search.
export async function handleContactMessage({ business, from, text, contextId, persona = null }) {
  // Once findContactByPhone below has identified the sender as a contact,
  // this message belongs to the relay — full stop. A later throw (e.g. a
  // transient DB error) must still be consumed here, never fall through to
  // the conversation agent, which would sell to the business's own rep and
  // create a contacts row for them in the client's lead inbox.
  let recognized = false;
  try {
    const contact = await findContactByPhone(business.id, from);
    if (!contact) return false;
    recognized = true;

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

    // A button/interactive tap whose text failed to extract, or a bare
    // "#3" with nothing after the code, must never be relayed as a blank
    // WhatsApp message — and must not be treated as an answer.
    if (!body) {
      await send({ to: from, text: 'לא הבנתי — אפשר לכתוב את התשובה במילים?', businessId: business.id });
      return true;
    }

    const reply = await voiceRewrite(body, persona);
    const sendRes = await send({ to: row.session_id, text: reply, businessId: business.id });
    const delivered = !!sendRes?.messages?.[0]?.id;

    // sendWhatsAppMessage never throws on a Graph error or a fetch failure —
    // it logs and returns the Graph error body (or undefined). Never mark
    // the question answered, and never tell the rep it's done, unless
    // delivery to the LEAD actually succeeded — otherwise the row goes
    // silently 'answered' while the lead heard nothing and the nudges
    // (Task 8) stop chasing a question that was never really resolved.
    if (!delivered) {
      console.error(`[relay] failed to deliver answer to the lead for escalation ${row.id}`);
      await send({ to: from, text: 'לא הצלחתי לשלוח את התשובה ללקוח — ננסה שוב.', businessId: business.id });
      return true;
    }

    await store.markAnswered(row.id, body);
    await recordHistory({ business, row, reply });

    // When we had to guess, name the thread so a mis-route is visible at once.
    const ack = matchedBy === 'recent' ? `נשלח ✓ (${row.session_id})` : 'נשלח ✓';
    await send({ to: from, text: ack, businessId: business.id });
    return true;
  } catch (e) {
    console.error('[relay] contact message failed:', e.message);
    return recognized;
  }
}
