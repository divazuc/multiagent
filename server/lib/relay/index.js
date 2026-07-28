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
    // The LEAD's row in `contacts` — their name and the async-generated
    // ai_summary. Keyed by phone, which for a live WhatsApp session IS the
    // session_id (index.js:377 upserts the contact under exactly that value).
    async getLeadContact(businessId, phone) {
      const { data, error } = await supabase.from('contacts')
        .select('name, ai_summary').eq('business_id', businessId).eq('phone', phone).maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
    // EVERY business's WhatsApp line, not just this one's — see
    // assertNotPlatformNumber. Small (one row per tenant) and read at most once
    // per escalation / once per nudge pass.
    async listPlatformWhatsappNumbers() {
      const { data, error } = await supabase.from('businesses')
        .select('whatsapp_number').not('whatsapp_number', 'is', null);
      if (error) throw error;
      return data ?? [];
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
// A LOCAL refusal — no template configured — costs nothing and applies
// identically to every send, so it is decided BEFORE any database write. That
// matters now that raiseEscalation reserves the row first: with the template
// env deliberately unset (today's production state) an insert-then-refuse
// ordering would churn one reserved-and-immediately-expired row per escalation
// attempt, for nothing.
function canSendToContact(templateEnv) {
  return !!sender || !!process.env[templateEnv]?.trim();
}

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

// BOT-TO-BOT LOOP BREAKER. The own-number guard below compares only against
// THIS business's whatsapp_number. If a rep contact phone is the WABA line of
// ANOTHER business on the platform, there is an unbounded loop:
//
//   A escalates -> messages B's line -> B's agent answers as if to a lead ->
//   A's contact gate recognises B as a listed contact -> A relays B's answer
//   to A's lead and acks B -> B's agent answers the ack -> forever.
//
// Only the first hop is a template; every hop after it sits inside a session
// window, so it is cheap per message and unbounded in count. This is not
// hypothetical: two production businesses currently share the whatsapp_number
// 972559489893, and the owner-contact backfill has already put platform WABA
// numbers into contact rows once.
//
// Fails CLOSED: if the list cannot be read we do not know whether the
// destination is a bot, and "send it anyway" is the one answer that can start
// the loop. Returns null when the seam does not implement the lookup at all,
// which only happens in fixtures that predate it.
async function platformNumberSet() {
  const d = await getDb();
  if (typeof d.listPlatformWhatsappNumbers !== 'function') return null;
  const rows = await d.listPlatformWhatsappNumbers();
  return new Set((rows ?? []).map(r => normalizePhone(r?.whatsapp_number)).filter(Boolean));
}

function holdingLineFor(persona) {
  return persona?.bot_gender === 'male'
    ? 'אני צריך לבדוק את זה, אעדכן בקרוב.'
    : 'אני צריכה לבדוק את זה, אעדכן בקרוב.';
}

// Who is asking, and what about. Without this the rep reads
// "#3 · — / סיכום: — / <question>" on EVERY escalation — the placeholder was
// never the anonymous-lead case, it was every case, because conversation.js
// passed `context.contact_summary` (a key nothing in the repo sets) and no name
// at all. The rep cannot answer "can she pay in instalments?" without knowing
// who she is.
//
// Design spec §2: snapshot contacts.ai_summary, and because it is generated
// asynchronously (index.js:378) it is null or stale on a first-message
// escalation — so fall back to the last few turns rather than sending nothing.
//
// Purely cosmetic, so it never fails the escalation: a thrown lookup degrades
// to the history fallback, and no history degrades to the placeholder.
const SUMMARY_TURNS = 3;

function summaryFromHistory(history) {
  if (!Array.isArray(history)) return null;
  const turns = history
    .filter(m => m?.content)
    .slice(-SUMMARY_TURNS)
    .map(m => `${m.role === 'assistant' ? 'בוט' : 'ליד'}: ${String(m.content).replace(/\s+/g, ' ').trim()}`)
    .filter(s => s.length > 5);
  return turns.length ? turns.join(' | ') : null;
}

async function leadSnapshot({ businessId, sessionId, leadName, summary, history }) {
  if (leadName && summary) return { leadName, summary }; // caller knows better
  let contact = null;
  try {
    contact = await (await getDb()).getLeadContact?.(businessId, sessionId) ?? null;
  } catch (e) {
    console.error('[relay] lead contact lookup failed — the rep gets a thinner message:', e.message);
  }
  return {
    leadName: leadName ?? contact?.name ?? null,
    summary: summary ?? contact?.ai_summary ?? summaryFromHistory(history),
  };
}

function repMessage({ code, leadName, summary, question }) {
  const who = leadName ? ` · ${leadName}` : '';
  const ctx = summary ? `\nסיכום: ${summary}` : '';
  return `#${code}${who}${ctx}\nהשאלה: ${question}\n\nענו להודעה הזו (Reply) כדי שאעביר את התשובה.`;
}

// Returns null when no relay is possible — the caller then keeps today's
// behaviour. NEVER tell a lead we are checking if nobody was asked.
export async function raiseEscalation({ business, session_id, question, reason = null, summary = null, leadName = null, persona = {}, history = null }) {
  try {
    const rep = await resolveRep(business.id);
    if (!rep) return null;

    if (!canSendToContact('WHATSAPP_ESCALATION_TEMPLATE')) {
      console.error(`[relay] WHATSAPP_ESCALATION_TEMPLATE is not configured — refusing to escalate (business=${business.id})`);
      return null;
    }

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

    // The same guard widened to every tenant — see platformNumberSet. A throw
    // here reaches the outer catch and returns null, which is the intended
    // fail-closed outcome.
    const platform = await platformNumberSet();
    if (repPhone && platform?.has(repPhone)) {
      console.error(`[relay] refusing to escalate: resolved rep phone is a platform WhatsApp line (business=${business.id})`);
      return null;
    }

    const open = await store.listOpen(business.id);

    // Dedupe per lead. Without this, every escalate-intent message from one
    // persistent lead buys another billable rep template and another open row
    // — up to the 99-code ceiling, each then drawing nudge_max_count more
    // templates (~495 conversations, most outside the 24h window at ~3.7x the
    // session rate). The holding line invites exactly that behaviour, so the
    // lead is still answered; the rep simply isn't asked twice.
    if (open.some(r => r.session_id === session_id)) {
      console.log(`[relay] ${session_id} already has an open escalation at ${business.id} — not asking the rep again`);
      return { holdingLine: holdingLineFor(persona) };
    }

    const code = store.pickShortCode(open);
    const lead = await leadSnapshot({
      businessId: business.id, sessionId: session_id, leadName, summary, history,
    });

    // INSERT BEFORE SEND. nextShortCode/pickShortCode is check-then-act, and
    // the partial unique index escalations_open_code_uniq exists to make the
    // loser of that race fail here. If we sent first, the rep would hold a real
    // "#3 · <lead A's question>" with no row behind it — and correlate.js would
    // then fall past the (unknown) quoted id to the CODE, matching the OTHER
    // open row that legitimately holds #3. Lead B would receive the answer to
    // lead A's question, which in a clinic may be a price.
    //
    // The inverted failure — a reserved row whose send never happened — is the
    // genuinely milder one, and it is bounded: it is marked expired below, and
    // the absolute age cap in nudgePass catches anything that escapes that.
    let row;
    try {
      row = await store.createEscalation({
        business_id: business.id, session_id, short_code: code,
        question, reason, summary: lead.summary, rep_phone: rep.phone,
        rep_message_id: null, status: 'open',
        created_at: new Date().toISOString(),
      });
    } catch (e) {
      console.error(`[relay] could not reserve short code ${code} for ${business.id} — not messaging the rep:`, e.message);
      return null;
    }
    if (!row?.id) {
      console.error(`[relay] escalation insert returned no id for ${business.id} — not messaging the rep`);
      return null;
    }

    const res = await sendToContact({
      to: rep.phone,
      businessId: business.id,
      templateEnv: 'WHATSAPP_ESCALATION_TEMPLATE',
      bodyParams: [code, lead.leadName, lead.summary, question],
      fallbackText: repMessage({ code, leadName: lead.leadName, summary: lead.summary, question }),
    });
    const repMessageId = res?.messages?.[0]?.id ?? null;
    if (!repMessageId) {
      // Release the short code and stop the nudge ladder before it starts —
      // an open row nobody was asked about would answer the rep's NEXT reply.
      try { await store.markExpired(row.id); }
      catch (e) { console.error(`[relay] could not expire the unsent escalation ${row.id}:`, e.message); }
      return null;
    }
    await store.setRepMessageId(row.id, repMessageId);

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
  //
  // The lookup ITSELF failing is a third case, and it fails closed: `false`
  // here would mean "this is a lead" on the strength of a transient DB error,
  // which is the one thing this function exists to prevent.
  let recognized = false;
  try {
    let contact;
    try {
      contact = await findContactByPhone(business.id, from);
    } catch (e) {
      console.error('[relay] contact lookup failed — refusing to hand the message to the conversation agent:', e.message);
      return true;
    }
    if (!contact) return false;
    recognized = true;

    // The loop's other entry point, and the worse one: an inbound message from
    // a platform WABA line would be treated as a REP ANSWER — rewritten into
    // this bot's voice and relayed to a real lead, bypassing every guardrail by
    // design (spec §6, the rep is authoritative). One tenant's bot would be
    // putting words in another tenant's mouth, and each ack would feed the next
    // turn. Consume it and say nothing: no ack, no relay, no pipeline.
    const fromPhone = normalizePhone(from);
    const platform = await platformNumberSet();
    if (fromPhone && platform?.has(fromPhone)) {
      console.error(`[relay] ignoring a message from a platform WhatsApp line listed as a contact of ${business.id}`);
      return true;
    }

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
// The derived term is clamped because it is NOT operator-only: /business/update
// has no column whitelist and no auth unless STUDIO_AUTH_REQUIRED === 'true',
// so nudge_interval_hours / nudge_max_count are writable well past what the
// admin UI's own 24h x 20 limit would allow. One week is longer than any
// legitimate ladder and short enough that a zombie row cannot leak a short code
// or swallow a rep's reply for a month.
const ABSOLUTE_MAX_AGE_HOURS = 72;
const HARD_MAX_AGE_HOURS = 168;
function maxAgeHoursFor({ intervalHours, maxNudges }) {
  const derived = Number(intervalHours) * (Number(maxNudges) + 1);
  const floor = Math.max(ABSOLUTE_MAX_AGE_HOURS, Number.isFinite(derived) ? derived : 0);
  return Math.min(floor, HARD_MAX_AGE_HOURS);
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

  // Read once per pass, not once per row. A rep_phone can be a platform WABA
  // line even though raiseEscalation now refuses to create such a row: rows
  // predating that guard, and a business whose whatsapp_number changed after
  // the escalation was raised. Fails closed — an unreadable list means every
  // destination is treated as unverified and nothing is sent, while the age cap
  // still expires the rows.
  let platform = null;
  try {
    platform = await platformNumberSet();
  } catch (e) {
    console.error('[relay] platform number list unreadable — no nudges will be sent this pass:', e.message);
    platform = 'unknown';
  }

  for (const row of open) {
    try {
      const settings = await settingsFor(row.business_id);

      // Backstop first, so it applies whatever the interval gate or the
      // send would have done. A row with no created_at (only fixtures — the
      // column is NOT NULL DEFAULT now() in prod) is treated as brand new
      // rather than as infinitely old; guessing 'ancient' would expire real
      // questions on a schema surprise.
      //
      // An UNPARSEABLE timestamp is the opposite case and must fail closed.
      // new Date('garbage').getTime() is NaN, and NaN loses every comparison:
      // `NaN >= maxAge` is false so the cap never fired, `NaN < interval` is
      // false so the gate never skipped, and the row was nudged on every single
      // pass forever — each one a billable business-initiated conversation.
      const createdMs = new Date(row.created_at ?? now).getTime();
      if (!Number.isFinite(createdMs)) {
        console.error(`[relay] escalation ${row.id} has an unreadable created_at (${row.created_at}) — expiring it`);
        await store.markExpired(row.id); expired++; continue;
      }
      const ageMs = now.getTime() - createdMs;
      if (ageMs >= maxAgeHoursFor(settings) * 3600 * 1000) {
        console.error(`[relay] escalation ${row.id} passed the absolute age cap — expiring it`);
        await store.markExpired(row.id); expired++; continue;
      }

      const since = new Date(row.last_nudge_at ?? row.created_at ?? now).getTime();
      if (!Number.isFinite(since)) {
        console.error(`[relay] escalation ${row.id} has an unreadable last_nudge_at (${row.last_nudge_at}) — expiring it`);
        await store.markExpired(row.id); expired++; continue;
      }
      if (now.getTime() - since < settings.intervalHours * 3600 * 1000) continue;
      if (row.nudge_count >= settings.maxNudges) { await store.markExpired(row.id); expired++; continue; }
      if (!canNudge) continue;                            // refused before any attempt — no charge
      // Refused before any attempt too, so it charges nobody: the escalation is
      // unanswerable rather than unattended, and the age cap will close it.
      const dest = normalizePhone(row.rep_phone);
      if (platform === 'unknown' || (dest && platform?.has(dest))) {
        console.error(`[relay] not nudging ${row.id} — the rep phone is a platform WhatsApp line or could not be verified`);
        continue;
      }
      if (!(await isOpenNow(row.business_id))) continue;  // no counter change

      // CHARGE BEFORE SENDING. recordNudge is the only thing that advances
      // last_nudge_at, so if it fails after the send the interval gate passes
      // again on the very next pass and the rep is nudged again — a 5-minute
      // scheduler would bill ~860 templates before the age cap caught it.
      // Reserving first means a failed charge throws into the per-row catch and
      // nothing is sent. The cost of the inverse (charged, then the send is
      // rejected) is one lost reminder, and the row still marches to the
      // ceiling, which is exactly the behaviour Task 10 fixed for rejected
      // sends anyway.
      await store.recordNudge(row.id);

      const res = await sendToContact({
        to: row.rep_phone,
        businessId: row.business_id,
        templateEnv: 'WHATSAPP_NUDGE_TEMPLATE',
        bodyParams: [row.short_code, row.question],
        fallbackText: `תזכורת #${row.short_code} — עדיין ממתינה תשובה:\n${row.question}\n\nלהפסקת התזכורות השיבו "עצור".`,
      });
      // The charge above is unconditional by design: an ATTEMPTED send counts
      // even when Graph rejects it, because markExpired has exactly one caller
      // and it is gated solely on nudge_count — withholding the increment is
      // what makes a row immortal. `nudged` still counts only real deliveries.
      const nudgeMessageId = res?.messages?.[0]?.id;
      if (nudgeMessageId) {
        nudged++;
        // The rep is most likely to quote-reply to THIS message, not the
        // original — keep its id matchable or the answer reaches another lead.
        await store.attachNudgeMessageId(row.id, nudgeMessageId);
      } else {
        console.error(`[relay] nudge to the rep was rejected for ${row.id} — counted toward the ceiling anyway`);
      }
    } catch (e) {
      console.error('[relay] nudge failed for', row.id, e.message);
    }
  }
  return { nudged, expired };
}
