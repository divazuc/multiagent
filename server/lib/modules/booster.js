// Booster (divaz_booster) quote-lead module — seam 3 of the divazuc <-> bot
// integration. Lets the sales/hybrid conversation agent create a personal
// quote-building link for a customer and recover it later if lost. Diva's
// own business only (enabled per-business like every module, via
// business_modules — see docs/superpowers/sdd/2026-08-07-divazuc-flow-api-
// bot-integration/task-16-report.md for the exact enablement done).
//
// No OAuth, no per-business secrets: auth to the booster is a single shared
// bearer token read from env inside booster-client.js.
//
// T4 (funnel track 1): the context is no longer purely static — the webhook's
// own WhatsApp messages never enter conversation history (F4), so the block
// now reads the SENDER's funnel status from the booster (60s cache,
// fail-soft) and steers the model per stage: schedule the characterization
// meeting at awaiting_meeting, ask for the payment screenshot at the payment
// stage, offer materials_done at the materials stage — and always route an
// extra-meeting request to the callback escalation instead of the calendar.
import { z } from 'zod';
import * as boosterClientReal from '../booster-client.js';
import { realLeadName } from '../booster-client.js';
import { hebDateDMY } from '../heb-date.js';
import { latestCtwaReferral, toBoosterAttribution } from '../ctwa.js';

// Test seam — same convention as booster-webhook.js's _setSendForTest:
// production always uses the real HTTP client; tests inject a stub so
// success/idempotent/not-found paths can be asserted without a network call.
let boosterClient = boosterClientReal;
export function _setBoosterClientForTest(fake) { boosterClient = fake ?? boosterClientReal; }

// Relay seam — the callback escalation goes through lib/relay's
// raiseEscalation (lazy import, same discipline as conversation.js: the relay
// pulls in supabase-touching modules that tests must never load).
let relayRaise = null;
export function _setRelayForTest(fn) { relayRaise = fn; }
async function raiseRelay(args) {
  const raise = relayRaise ?? (await import('../relay/index.js')).raiseEscalation;
  return raise(args);
}

// CTWA attribution seam — lets a test prove the fail-soft path for real.
// latestCtwaReferral is documented never to throw; the handler guards anyway,
// because this call sits in front of lead CREATION and the cost of being wrong
// is asymmetric (see boosterAttribution).
let ctwaLookup = null;
export function _setCtwaLookupForTest(fn) { ctwaLookup = fn; }

// The Meta ad identity was captured on the conversation's FIRST message
// (lib/ctwa.js) and is read back here, at the only moment it can be attached
// to anything. Returns undefined — not null, not {} — when there is nothing to
// attach, so createBoosterLead's own `utm = {}` default applies and an
// unattributed lead carries no invented attribution.
//
// FAIL-SOFT IS THE POINT: losing a tag is a reporting gap; losing a lead is a
// lost customer. Nothing in here may propagate.
async function boosterAttribution(business, sessionCtx) {
  try {
    const lookup = ctwaLookup ?? latestCtwaReferral;
    const referral = await lookup({ businessId: business?.id, phone: sessionCtx?.session_id });
    return toBoosterAttribution(referral) ?? undefined;
  } catch (e) {
    console.error('[booster] CTWA attribution lookup failed — creating the lead untagged:', e.message);
    return undefined;
  }
}

const settingsSchema = z.object({}).passthrough();

const HEB_DAY_NAMES = ['יום ראשון', 'יום שני', 'יום שלישי', 'יום רביעי', 'יום חמישי', 'יום שישי', 'שבת'];
const PACKAGE_LABELS = { mini: 'מיני לנדינג', landing: 'דף נחיתה', corporate: 'אתר תדמית' };
const packageLegend = Object.entries(PACKAGE_LABELS).map(([id, label]) => `${label}=${id}`).join(', ');

// The quote-flow instructions are half the fix for the interrogation bug.
// The old opener — "כשלקוח מבקש הצעת מחיר ומוסר שם מלא + אימייל + בחירת חבילה"
// — made the link CONDITIONAL on identity, and the model did exactly as told:
// the express opener came back with "אצטרך שם מלא ואימייל — מה הפרטים?" instead
// of a link. Identity is collected downstream by the questionnaire and the
// digital signature, so the only thing the bot must extract here is the
// package. Relaxing the schema alone would not have fixed this; the model has
// to be told to stop asking.
const CONTEXT = `## הצעת מחיר אישית (בוסטר)
כשלקוח מבקש הצעת מחיר, מתעניין במסלול או בוחר חבילה (${packageLegend}) — שלח/י לו את הקישור האישי מיד, כבר בתשובה הזאת. הוסף/י בסוף התשובה שורה נפרדת בפורמט המדויק:
<<ACTION:booster.create_quote_lead{"package_id":"mini|landing|corporate"}>>
השדה היחיד שחובה הוא package_id. אם הלקוח כבר אמר את שמו בשיחה — אפשר להוסיף "name":"השם שמסר"; אם לא אמר, אל תוסיף/י את השדה כלל. כנ"ל לגבי "email" (רק אם הלקוח כתב אותו במפורש) ו-"business_note" (רק אם יש הערה קצרה שרלוונטית לדיוה).
אל תבקש/י שם או אימייל לפני שליחת הקישור — השאלון והחתימה אוספים את הפרטים.
רק אם לא ברור באיזו חבילה מדובר — שאל/י שאלה קצרה אחת על החבילה בלבד, ואז שלח/י את הקישור.
אל תמציא/י קישור בעצמך ואל תציג/י את השורה הזאת ללקוח כטקסט רגיל — המערכת מבצעת את הפעולה ומצרפת את הקישור האמיתי לתשובה מיד אחריה. אל תבטיח/י "שלחתי לך קישור" לפני שהפעולה בוצעה בפועל.
אם לקוח שכבר קיבל קישור בעבר מבקש אותו שוב (איבד אותו, לא מוצא, וכו') ואין צורך במידע נוסף — הוסף/י שורה נפרדת:
<<ACTION:booster.resend_quote_link{}>>
מספר הטלפון של הלקוח מזוהה אוטומטית מהשיחה — לעולם אל תבקש/י אותו ואל תכלול/י אותו בתוך ה-ACTION.`;

// ── Status-aware context (T4) ────────────────────────────────────────────────

// Pinned copy (funnel plan, iron rules): the bot never confirms a payment or
// an approval of materials — only Diva does — and never prints prices.
const CALLBACK_REPLY = 'דיוה תחזור אליך בהקדם 🙂';

// What the customer actually receives with the link. It replaces an
// interrogation, so it has to answer the question the customer was about to
// ask — "what happens now?" — in one short message: what the link does, then
// the meeting, then how long the link lives.
//
// The process sentence is the OWNER'S, dictated verbatim after her live demo.
// Do not rewrite it, and do not bring back the "calculator" noun this line used
// to lead with — she banned that word outright ("נשמע זול ומיושן").
// test/booster-module.test.js pins the sentence, and bans the word across this
// whole file including comments, so that it cannot creep back in by quotation.
//
// Rules baked in: no ₪ and no totals (only the quote flow and Diva quote
// money), no personal-area promise (not live), and Diva is one person — the
// scheduling happens here in the chat, per the awaiting_meeting guidance
// below and docs/booster-meeting-scheduling-handoff.md §1.
const QUOTE_PROCESS = 'ממלאים שאלון היכרות קצר, בוחרים מסלול ותוספות ומקבלים הצעת מחיר מותאמת בלי להמתין!';

// Kept out of QUOTE_PROCESS: her sentence ends at the quote, and what happens
// after signing is a separate promise this chat has to honour.
const MEETING_AFTER_SIGNATURE = 'אחרי החתימה נתאם כאן פגישת אפיון קצרה עם דיוה.';

// Owner, 2026-08-29 ("חשוב לי שיהיה להם שקיפות… זה מייצר ביטחון"): the one
// sentence every surface was missing — nothing is paid and nothing is owed
// until the meeting; the payment step after it is where the decision is made.
// Sits right after the meeting line it qualifies, before the validity clock.
const NO_COMMITMENT_BEFORE_MEETING = 'עד הפגישה אין תשלום ואין שום התחייבות — מחליטים רק אחריה 🙂';

// The express pre-signature link window. Only a fallback: the booster stamps
// the real number on the lead and it arrives as lead.validDays. Read the
// three-clocks warning in lib/booster-messages.js before touching this — 14
// here is the LINK window, not the 30-day post-signature quote validity and
// not the 14-day payment deadline.
const EXPRESS_LINK_VALID_DAYS = 14;

function quoteLinkText(lead) {
  const opener = lead.created
    ? 'הנה הקישור האישי שלך להצעת המחיר 👇'
    : 'הנה שוב הקישור האישי שלך להצעת המחיר 👇';
  const days = lead.validDays ?? EXPRESS_LINK_VALID_DAYS;
  return `${opener}\n${lead.linkUrl}\n\n${QUOTE_PROCESS}\n${MEETING_AFTER_SIGNATURE}\n${NO_COMMITMENT_BEFORE_MEETING}\nהקישור בתוקף ל-${days} ימים.`;
}
const MATERIALS_ACK = 'קיבלתי! עדכנתי את דיוה — היא תעבור על החומרים ותאשר שמתחילים 🙏';
const MATERIALS_ALREADY = 'כבר עדכנתי את דיוה, היא בודקת 🙏';
const MATERIALS_FAIL = 'אופס, לא הצלחתי לעדכן — נסו שוב עוד רגע 🙏';
// A 409 wrong_status will never succeed on a retry, so it must not be answered
// with "נסו שוב עוד רגע" — the lead simply is not at the materials stage.
const MATERIALS_WRONG_STATUS = 'עוד לא פתחנו אצלך את שלב החומרים — דיוה תחזור אליך בהקדם 🙂';

// Any known express lead: one characterization meeting per order (handoff §2)
// — an extra-meeting request routes to Diva, never to the calendar.
const EXPRESS_RULE = `## לקוח מסלול אקספרס — כלל פגישת אפיון אחת
ללקוח הזה יש הזמנה במסלול האקספרס, הכוללת פגישת אפיון אחת בלבד. אם הלקוח מבקש שיחה או פגישה נוספת מעבר לפגישת האפיון של ההזמנה — אל תתאם/י ביומן ואל תבטיח/י מועד; הוסף/י בסוף התשובה שורה נפרדת בפורמט המדויק:
<<ACTION:booster.request_callback{}>>
המערכת מעדכנת את דיוה, והלקוח מקבל מענה קבוע מיד אחרי השורה הזאת.`;

const PAYMENT_STAGE = `הלקוח נמצא בשלב השלמת התשלום. אם הלקוח כותב ששילם — בקש/י ממנו לשלוח כאן צילום מסך של אישור התשלום. לעולם אל תאשר/י בעצמך שהתשלום התקבל, נבדק או אושר — רק דיוה מאשרת. אל תנקוב/י בסכומים או במחירים.`;

const MATERIALS_STAGE = `הלקוח נמצא בשלב העברת החומרים (קיבל קישורים לתיקייה ולמסמכים). כשהלקוח מודיע שסיים להעלות את החומרים ("סיימתי", "העליתי הכל" וכד') — הוסף/י בסוף התשובה שורה נפרדת בפורמט המדויק:
<<ACTION:booster.materials_done{}>>
לעולם אל תודיע/י שהחומרים נבדקו או שמתחילים לעבוד — רק דיוה בודקת ומאשרת את זה.`;

const STAGE_GUIDANCE = {
  awaiting_meeting: `הלקוח חתם על ההצעה והשלב הנוכחי שלו הוא פגישת האפיון עם דיוה — תיאום פגישת האפיון כאן בצ'אט הוא הזרימה הרגילה: הצע/י מועדים אמיתיים מתוך מודול תיאום הפגישות וקבע/י דרכו. אל תשלח/י שוב את קישור ההצעה, ואל תדון/י בסכומים — פרטי ההמשך יגיעו מדיוה אחרי הפגישה.`,
  awaiting_payment: PAYMENT_STAGE,
  payment_proof_sent: PAYMENT_STAGE,
  awaiting_materials: MATERIALS_STAGE,
  materials_declared: MATERIALS_STAGE,
};

// 60s cache per sender: one booster round-trip per conversation turn burst,
// and one more a minute later. Bounded like the webhook's dedup Set.
//
// KNOWN LIMITATION (accepted for v1, noted in review): the key is the phone
// alone, not (business_id, phone). The booster is Diva's tenant only and its
// leads are global to the booster anyway, so today every hit is the same
// answer — but if a second tenant ever enables this module, a sender who talks
// to both would share one cache entry. Key it on the business too at that
// point.
const STATUS_TTL_MS = 60_000;
// Stale-while-error horizon (owner E2E 2026-08-29): a lookup that fails must not
// erase what we already knew about the client mid-conversation — a signed lead
// was asked for her name. Within this window the last fetched lead still drives
// the context; beyond it we admit we do not know.
const STATUS_STALE_OK_MS = 24 * 60 * 60_000;
const statusCache = new Map(); // session_id -> { at, lead }
export function _clearStatusCacheForTest() { statusCache.clear(); }
export function _seedStatusCacheForTest(sessionId, lead, at = Date.now()) { statusCache.set(sessionId, { at, lead }); }

function rememberLead(sessionId, lead) {
  statusCache.set(sessionId, { at: Date.now(), lead });
  if (statusCache.size > 500) statusCache.delete(statusCache.keys().next().value);
}

async function leadForSession(sessionId) {
  const hit = statusCache.get(sessionId);
  if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.lead;
  try {
    const lead = await boosterClient.lookupBoosterLeadByPhone(sessionId);
    rememberLead(sessionId, lead);
    return lead;
  } catch (e) {
    if (hit?.lead && Date.now() - hit.at < STATUS_STALE_OK_MS) {
      console.error('[booster] status lookup failed — serving the last known lead:', e.message);
      return hit.lead;
    }
    throw e;
  }
}

async function statusContext(sessionId, businessId = null) {
  if (!sessionId) return null;
  // Fail-soft: an unreachable booster must never break the reply pipeline —
  // the static block alone is what shipped before T4 and it still stands.
  // Errors are NOT cached, so the very next message retries.
  let lead;
  try {
    lead = await leadForSession(sessionId);
  } catch (e) {
    console.error('[booster] status lookup failed — static context only:', e.message);
    return null;
  }
  if (!lead) return null;
  const stage = STAGE_GUIDANCE[lead.status];
  const blocks = [EXPRESS_RULE];
  // The signed quote already carries the client's name — asking for it again
  // ("רק צריכה את שמך המלא", live bug) reads as not knowing your own customer.
  // realLeadName filters the booster's "ליד וואטסאפ" placeholder, which is not
  // a name anyone should be greeted by. Telling the model is HALF the fix; the
  // reply pipeline also injects the name into a calendar booking the model
  // sent without one (lib/module-action-step.js).
  const knownName = realLeadName(lead.name);
  if (knownName) {
    blocks.push(`## שם הלקוח ידוע\nהשם של הלקוח הזה כבר ידוע מההצעה: ${knownName}. לעולם אל תבקש/י ממנו את שמו — השתמש/י בשם הזה בכל מקום שנדרש שם (למשל בקביעת פגישה).`);
  }
  if (stage) blocks.push(`## השלב הנוכחי של הלקוח בתהליך\n${stage}`);
  // Owner, 2026-08-29: a client with a CONFIRMED meeting who asks about it or
  // wants another time is offered a change — on the same road as the first
  // booking, through Diva's approval. The model must name the meeting that
  // exists and never announce a move before it is approved.
  if (lead.status === 'awaiting_meeting') {
    // Lazy: booster-meeting.js reaches the module registry, which loads this file — a static import would be a cycle.
    const booked = await import('../booster-meeting.js').then(m => m.getLatestMeetingEvent({ businessId, type: 'meeting_booked', phone: sessionId })).catch(() => null);
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(booked?.detail?.slot ?? ''));
    if (m) {
      const day = HEB_DAY_NAMES[new Date(`${m[1]}T00:00:00`).getDay()];
      blocks.push(`## פגישה קבועה\nללקוח הזה כבר קבועה פגישת אפיון: ${day ? `${day} ` : ''}${hebDateDMY(m[1])} בשעה ${m[2]}. אם הוא שואל על הפגישה או מבקש מועד אחר — ציין/י את המועד הקבוע ושאל/י אם הוא רוצה להחליף אותו. אם כן — הצע/י מועדים מהרשימה ושלח/י calendar.book עם המועד החדש כרגיל; הבקשה תעבור לאישור דיוה, והמועד הקודם יוחלף רק אחרי האישור. אל תבטיח/י שהפגישה הוזזה.`);
    }
  }
  return blocks.join('\n\n');
}

const boosterModule = {
  key: 'booster',
  name: 'הצעת מחיר אישית (בוסטר)',
  portalVisible: false, // v1: not shown in the client portal
  settingsSchema,
  defaultSettings: settingsSchema.parse({}),

  async contextProvider(_business, _row, sessionCtx) {
    const dynamic = await statusContext(sessionCtx?.session_id, _business?.id ?? null);
    return dynamic ? `${CONTEXT}\n\n${dynamic}` : CONTEXT;
  },

  actions: {
    // Input never carries a phone — the sender's number comes from the
    // conversation's own session_id (sessionCtx), never from the model.
    create_quote_lead: {
      // package_id is the ONLY required field. name/email are optional and,
      // more importantly, UNFAILABLE: executeModuleAction answers a rejected
      // parse with invalid_payload and no text, so a model that hallucinated
      // "email":"לא-יודע" would cost the customer the link entirely. .catch()
      // drops anything unusable instead of blocking the action — the booster
      // defaults both server-side, and the questionnaire and the signature
      // collect the real identity later.
      schema: z.object({
        name: z.string().trim().min(1).optional().catch(undefined),
        email: z.string().trim().email().optional().catch(undefined),
        package_id: z.enum(['mini', 'landing', 'corporate']),
        business_note: z.string().trim().optional().catch(undefined),
      }),
      async handler(business, _row, payload, sessionCtx) {
        const utm = await boosterAttribution(business, sessionCtx);
        // Name precedence: what the customer actually said > their WhatsApp
        // display name > nothing (the booster's own default). The profile name
        // comes from the CHANNEL via sessionCtx, never from the model — same
        // contract as the phone — so the lead reaches Diva with a name without
        // the bot having asked for one.
        // Trimmed here too, not only in normalize.js: this handler is also
        // reachable from the engine with a sessionCtx built elsewhere, and a
        // whitespace "name" would overwrite the booster's default with nothing.
        const name = String(payload.name ?? sessionCtx?.profile_name ?? '').trim();
        const lead = await boosterClient.createBoosterLead({
          phone: sessionCtx?.session_id,
          packageId: payload.package_id,
          businessNote: payload.business_note,
          // Omitted rather than sent as null/"": an absent field lets the
          // booster apply its default, an empty one overwrites it.
          ...(name ? { name } : {}),
          ...(payload.email ? { email: payload.email } : {}),
          ...(utm ? { utm } : {}),
        });
        // The bot just made this lead — the next turns must not depend on a
        // lookup round-trip to know the client's name and stage.
        if (sessionCtx?.session_id) rememberLead(sessionCtx.session_id, {
          leadId: lead.leadId, name: lead.name ?? (name || null), packageId: lead.packageId ?? payload.package_id,
          quoteUrl: lead.linkUrl ?? null, status: lead.status ?? 'lead', email: lead.email ?? payload.email ?? null,
        });
        return { confirmationText: quoteLinkText(lead) };
      },
    },

    // No input at all. Contract: link recovery goes ONLY to the number that
    // originally received it — sessionCtx.session_id is the sole source,
    // even if the model's payload tried to carry a phone (schema drops it).
    resend_quote_link: {
      schema: z.object({}),
      async handler(_business, _row, _payload, sessionCtx) {
        const lead = await boosterClient.lookupBoosterLeadByPhone(sessionCtx?.session_id);
        if (!lead) return { failureText: 'לא מצאתי הצעה פתוחה למספר הזה' };
        return { confirmationText: `הנה ההצעה שלך:\n${lead.quoteUrl}` };
      },
    },

    // T4 — the "another call" escalation (handoff §3): Diva is pinged through
    // the relay; the client always gets the one pinned line, even when the
    // relay cannot deliver (F1: WHATSAPP_ESCALATION_TEMPLATE unset in prod is
    // a known, accepted gap — Diva's action item, never the client's problem).
    // Empty schema: the phone comes only from sessionCtx.
    request_callback: {
      schema: z.object({}),
      async handler(business, _row, _payload, sessionCtx) {
        try {
          await raiseRelay({
            business,
            session_id: sessionCtx?.session_id,
            question: 'לקוח אקספרס מבקש שיחה נוספת עם דיוה (מעבר לפגישת האפיון של ההזמנה)',
            reason: 'callback_request',
          });
        } catch (e) {
          console.error('[booster] callback escalation failed — the client still gets the fixed reply:', e.message);
        }
        // replaceResponse: this line IS the answer. The model's own text is
        // what triggered the escalation in the first place — often an
        // improvised "בטח, אשריין לך שלישי ב-10" — so appending the pinned
        // line under it hands the client a promise and its retraction in one
        // message. The gate replaces; so does this.
        return { confirmationText: CALLBACK_REPLY, replaceResponse: true };
      },
    },

    // T4 — "סיימתי": tell the booster the materials are declared. The booster
    // owns the transition + Diva's Telegram ping; the bot's three replies are
    // pinned and NEVER claim an approval — only Diva's review does that.
    // Empty schema: the lead is resolved from the sender's phone alone.
    materials_done: {
      schema: z.object({}),
      async handler(_business, _row, _payload, sessionCtx) {
        try {
          const lead = await boosterClient.lookupBoosterLeadByPhone(sessionCtx?.session_id);
          if (!lead) return { failureText: MATERIALS_FAIL };
          const r = await boosterClient.declareMaterialsDone({ leadId: lead.leadId });
          statusCache.delete(sessionCtx?.session_id); // status just changed — don't serve the stale one
          return { confirmationText: r.already ? MATERIALS_ALREADY : MATERIALS_ACK };
        } catch (e) {
          console.error('[booster] materials-declared failed:', e.message);
          if (e.status === 409) return { failureText: MATERIALS_WRONG_STATUS };
          return { failureText: MATERIALS_FAIL };
        }
      },
    },
  },

  adminUI: { fields: [] },
};

export default boosterModule;
