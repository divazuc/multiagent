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

// Graph rejects a template parameter that contains a newline, a tab, or a run
// of four or more spaces — and a lead's WhatsApp question routinely contains a
// newline. It also rejects an empty parameter, which `leadName`/`summary`
// legitimately are, and one longer than 1024 characters, which `{{4}}` (the
// lead's raw question, up to 4096 chars inbound) can easily be. Any of the
// three fails the WHOLE send, so the rep would simply never be asked and the
// lead would silently lose the relay.
//
// 500 sits well under Meta's 1024 and leaves room for the other parameters;
// truncation is only ever cosmetic, because escalations.question always keeps
// the untruncated text and that is what the audit trail and the answer relay
// both read.
const MAX_TEMPLATE_PARAM_CHARS = 500;

function templateParam(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '—';
  if (s.length <= MAX_TEMPLATE_PARAM_CHARS) return s;
  const cut = s.slice(0, MAX_TEMPLATE_PARAM_CHARS - 1);
  const lastSpace = cut.lastIndexOf(' ');
  // Only honour a word boundary that isn't absurdly early — one 400-char
  // "word" (a URL, an unspaced paste) must not truncate back to nothing.
  const body = lastSpace > MAX_TEMPLATE_PARAM_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut;
  return body.trimEnd() + '…';
}

// Business-initiated sends to a CONTACT (the rep/owner) usually fall outside
// WhatsApp's 24h customer-service window, so they must go out as an approved
// template. Sends to the LEAD stay plain text — the lead has just messaged us
// — and so do the acks inside a rep's own reply thread.
//
// A missing template is a HARD STOP: nothing is sent and no message id comes
// back, so no caller can move state on the strength of it. index.js's
// follow-up sweep gets exactly this wrong — it writes status 'sent' with
// wa_send 'not_configured' when nothing left the building. Do not copy it.
//
// `sender` (the test seam) short-circuits first and deliberately never touches
// the template path: injected senders receive the readable plain text.
async function sendToContact({ to, businessId, templateEnv, bodyParams, fallbackText }) {
  if (sender) return sender({ to, businessId, text: fallbackText });
  const templateName = process.env[templateEnv]?.trim();
  if (!templateName) {
    console.error(`[relay] ${templateEnv} is not configured — refusing to send to a contact (business=${businessId})`);
    return null;
  }
  const { sendWhatsAppTemplate } = await import('../wa-send.js');
  return sendWhatsAppTemplate({
    to, templateName, langCode: 'he',
    bodyParams: bodyParams.map(templateParam), businessId,
  });
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
    const res = await sendToContact({
      to: rep.phone,
      businessId: business.id,
      templateEnv: 'WHATSAPP_ESCALATION_TEMPLATE',
      bodyParams: [code, leadName, summary, question],
      fallbackText: repMessage({ code, leadName, summary, question }),
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

// Narrower seam than _setRewriterForTest above: that one bypasses the model
// call entirely, so it can't exercise the response-handling branch below
// (the max_tokens/truncation guard). This stubs just `client.messages.create`
// — same lazy-import discipline, never touches the SDK when set.
let messagesCreate = null;
export function _setMessagesCreateForTest(fn) { messagesCreate = fn; }

const REWRITE_PROMPT = `אתה מנסח מחדש תשובה של בעל העסק כך שתישמע בקול של הבוט.
חוקים מוחלטים:
- אל תשנה, תוסיף או תוריד שום עובדה, מספר, מחיר, תאריך או שם.
- אל תרכך ואל תסייג. התשובה של בעל העסק היא הקובעת.
- שמור על אורך דומה, בעברית, בגוף ראשון.
החזר את הטקסט בלבד.`;

// Hebrew is token-dense and the input is a rep's real WhatsApp message (which
// can run long, e.g. a price plus conditions) — 1200 comfortably fits a
// rewritten answer without truncating it. See the stop_reason guard below:
// even with headroom, a truncated response must never reach the lead.
const REWRITE_MAX_TOKENS = 1200;

// Rewrites the human's answer into the bot's voice WITHOUT passing it through
// validate() or the forbidden-phrase check (conversation.js): the rep IS the
// business, so their answer is authoritative. Content must survive verbatim —
// only tone/gender/length may change. Fails soft: any error here, at any
// step, returns the raw answer — the rep's actual words always beat silence.
// That includes a truncated-but-not-erroring response (stop_reason ===
// 'max_tokens'): the API returns a normal 200 with non-empty, cut-off text in
// that case, so it must be checked explicitly — a truncated sentence can
// silently drop a trailing price condition just as badly as a fabrication.
async function voiceRewrite(answer, persona) {
  if (rewriter) return rewriter(answer, persona);
  try {
    const gender = persona?.bot_gender === 'male' ? 'זכר' : 'נקבה';
    const params = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: REWRITE_MAX_TOKENS,
      messages: [{ role: 'user', content: `${REWRITE_PROMPT}\nמגדר הבוט: ${gender}\n\nהתשובה:\n${answer}` }],
    };
    let res;
    if (messagesCreate) {
      res = await messagesCreate(params);
    } else {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      res = await client.messages.create(params);
    }
    if (res.stop_reason === 'max_tokens') {
      console.error('[relay] rewrite truncated (stop_reason=max_tokens), sending the raw answer instead of a cut-off sentence');
      return answer;
    }
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

// Absolute backstop on how long a row may sit 'open'. `nudge_count` reaching
// the ceiling is the NORMAL exit; this is the one that survives every failure
// mode that stops the counter from advancing at all — a rep number that isn't
// on WhatsApp, a rep who blocked the business, a template Meta paused, a
// WABA token that expired, WHATSAPP_NUDGE_TEMPLATE lost in a redeploy.
//
// It matters because an immortal open row is not merely untidy:
//   · correlate.js returns the single open row for ANY untagged rep reply, so
//     one zombie silently re-routes a rep's next answer to a dead lead;
//   · store.js#nextShortCode only allocates codes no open row holds, so
//     zombies leak the 1..99 space until inserts collide and raiseEscalation
//     starts returning null for that business.
//
// Derived, not flat, so it can never preempt a business's own configured
// ladder: a business on 24h × 4 legitimately needs ~96h, and a flat 72h cap
// would kill its escalations mid-ladder.
const ABSOLUTE_MAX_AGE_HOURS = 72;
function maxAgeHoursFor({ intervalHours, maxNudges }) {
  return Math.max(ABSOLUTE_MAX_AGE_HOURS, intervalHours * (maxNudges + 1));
}

// Nudges ride the follow-up processor's pass — this feature does not add a
// second scheduler. Every nudge outside the 24h window is a billable
// business-initiated conversation, hence the ceiling.
//
// Two distinct non-delivery cases, deliberately handled differently:
//   · a LOCAL REFUSAL (no template configured) happens before any attempt. It
//     applies identically to every row, so it is decided and logged ONCE per
//     pass, and charges nobody's budget — a config error must not burn a real
//     rep's reminders.
//   · an ATTEMPTED send Graph rejected DOES count toward the ceiling. It has
//     to: recordNudge is what eventually walks the row to markExpired, and
//     wa-send never throws, so a permanently undeliverable rep would
//     otherwise leave the row open forever.
//
// getNudgeSettings(businessId) is optional and injected (mirrors isOpenNow) so
// this stays unit-testable without a real business_profiles row. It is looked
// up AT MOST ONCE PER BUSINESS per pass via a Map cache, not once per open
// escalation — several leads waiting on the same rep must not multiply the
// query. A missing callback, a null/undefined result, a thrown error, or a
// row with the column simply absent all fall back to the intervalHours /
// maxNudges arguments — never a hard failure of the pass.
export async function nudgePass({ now = new Date(), isOpenNow, intervalHours = 2, maxNudges = 4, getNudgeSettings = null }) {
  let nudged = 0, expired = 0;
  const open = await store.listAllOpen();
  const settingsCache = new Map();

  async function settingsFor(businessId) {
    if (!getNudgeSettings) return { intervalHours, maxNudges };
    if (settingsCache.has(businessId)) return settingsCache.get(businessId);
    let resolved;
    try {
      const row = await getNudgeSettings(businessId);
      resolved = {
        intervalHours: Number(row?.nudge_interval_hours) || intervalHours,
        maxNudges: Number(row?.nudge_max_count) || maxNudges,
      };
    } catch (e) {
      console.error('[relay] nudge settings lookup failed for', businessId, '— using defaults:', e.message);
      resolved = { intervalHours, maxNudges };
    }
    settingsCache.set(businessId, resolved);
    return resolved;
  }

  // Decided once, not once per row — see the two cases above. The loop still
  // runs when this is false: the age backstop must keep expiring rows even
  // when nothing can be sent, or a template lost in a redeploy would leave
  // every already-open escalation immortal.
  const canNudge = !!sender || !!process.env.WHATSAPP_NUDGE_TEMPLATE?.trim();
  if (!canNudge) {
    console.error('[relay] WHATSAPP_NUDGE_TEMPLATE is not configured — no rep nudges will be sent this pass');
  }

  for (const row of open) {
    try {
      const settings = await settingsFor(row.business_id);

      // Backstop first, so it applies whatever the interval gate or the
      // send would have done. A row with no created_at (only fixtures — the
      // column is NOT NULL DEFAULT now() in prod) is treated as brand new
      // rather than as infinitely old; guessing 'ancient' would expire real
      // questions on a schema surprise.
      const ageMs = now.getTime() - new Date(row.created_at ?? now).getTime();
      if (ageMs >= maxAgeHoursFor(settings) * 3600 * 1000) {
        console.error(`[relay] escalation ${row.id} passed the absolute age cap — expiring it`);
        await store.markExpired(row.id); expired++; continue;
      }

      const since = new Date(row.last_nudge_at ?? row.created_at ?? now).getTime();
      if (now.getTime() - since < settings.intervalHours * 3600 * 1000) continue;
      if (row.nudge_count >= settings.maxNudges) { await store.markExpired(row.id); expired++; continue; }
      if (!canNudge) continue;                            // refused before any attempt — no charge
      if (!(await isOpenNow(row.business_id))) continue;  // no counter change

      const res = await sendToContact({
        to: row.rep_phone,
        businessId: row.business_id,
        templateEnv: 'WHATSAPP_NUDGE_TEMPLATE',
        bodyParams: [row.short_code, row.question],
        fallbackText: `תזכורת #${row.short_code} — עדיין ממתינה תשובה:\n${row.question}\n\nלהפסקת התזכורות השיבו "עצור".`,
      });
      // Charged unconditionally: this send was ATTEMPTED. If Graph rejected
      // it, the row must still march toward the ceiling — markExpired has
      // exactly one caller and it is gated solely on nudge_count, so
      // withholding the increment here is what makes a row immortal.
      // `nudged` still counts only what was really delivered.
      await store.recordNudge(row.id);
      if (res?.messages?.[0]?.id) nudged++;
      else console.error(`[relay] nudge to the rep was rejected for ${row.id} — counted toward the ceiling anyway`);
    } catch (e) {
      console.error('[relay] nudge failed for', row.id, e.message);
    }
  }
  return { nudged, expired };
}
