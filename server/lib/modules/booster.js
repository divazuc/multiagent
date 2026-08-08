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

const settingsSchema = z.object({}).passthrough();

const PACKAGE_LABELS = { mini: 'מיני לנדינג', landing: 'דף נחיתה', corporate: 'אתר תדמית' };
const packageLegend = Object.entries(PACKAGE_LABELS).map(([id, label]) => `${label}=${id}`).join(', ');

const CONTEXT = `## הצעת מחיר אישית (בוסטר)
כשלקוח מבקש הצעת מחיר ומוסר שם מלא + אימייל + בחירת חבילה (${packageLegend}) —
הוסף/י בסוף התשובה שורה נפרדת בפורמט המדויק:
<<ACTION:booster.create_quote_lead{"name":"שם מלא","email":"אימייל","package_id":"mini|landing|corporate","business_note":"הערה קצרה אם רלוונטי"}>>
אל תמציא/י קישור בעצמך ואל תציג/י את השורה הזאת ללקוח כטקסט רגיל — המערכת מבצעת את הפעולה ומצרפת את הקישור האמיתי לתשובה מיד אחריה. אל תבטיח/י "שלחתי לך קישור" לפני שהפעולה בוצעה בפועל.
אם לקוח שכבר קיבל קישור בעבר מבקש אותו שוב (איבד אותו, לא מוצא, וכו') ואין צורך במידע נוסף — הוסף/י שורה נפרדת:
<<ACTION:booster.resend_quote_link{}>>
מספר הטלפון של הלקוח מזוהה אוטומטית מהשיחה — לעולם אל תבקש/י אותו ואל תכלול/י אותו בתוך ה-ACTION.`;

// ── Status-aware context (T4) ────────────────────────────────────────────────

// Pinned copy (funnel plan, iron rules): the bot never confirms a payment or
// an approval of materials — only Diva does — and never prints prices.
const CALLBACK_REPLY = 'דיוה תחזור אליך בהקדם 🙂';
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
const statusCache = new Map(); // session_id -> { at, lead }
export function _clearStatusCacheForTest() { statusCache.clear(); }

async function leadForSession(sessionId) {
  const hit = statusCache.get(sessionId);
  if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.lead;
  const lead = await boosterClient.lookupBoosterLeadByPhone(sessionId);
  statusCache.set(sessionId, { at: Date.now(), lead });
  if (statusCache.size > 500) statusCache.delete(statusCache.keys().next().value);
  return lead;
}

async function statusContext(sessionId) {
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
  if (stage) blocks.push(`## השלב הנוכחי של הלקוח בתהליך\n${stage}`);
  return blocks.join('\n\n');
}

const boosterModule = {
  key: 'booster',
  name: 'הצעת מחיר אישית (בוסטר)',
  portalVisible: false, // v1: not shown in the client portal
  settingsSchema,
  defaultSettings: settingsSchema.parse({}),

  async contextProvider(_business, _row, sessionCtx) {
    const dynamic = await statusContext(sessionCtx?.session_id);
    return dynamic ? `${CONTEXT}\n\n${dynamic}` : CONTEXT;
  },

  actions: {
    // Input never carries a phone — the sender's number comes from the
    // conversation's own session_id (sessionCtx), never from the model.
    create_quote_lead: {
      schema: z.object({
        name: z.string().trim().min(1),
        email: z.string().trim().email(),
        package_id: z.enum(['mini', 'landing', 'corporate']),
        business_note: z.string().trim().optional(),
      }),
      async handler(_business, _row, payload, sessionCtx) {
        const lead = await boosterClient.createBoosterLead({
          name: payload.name,
          phone: sessionCtx?.session_id,
          email: payload.email,
          packageId: payload.package_id,
          businessNote: payload.business_note,
        });
        const text = lead.created
          ? `מעולה! הכנתי לך קישור אישי להצעת המחיר שלך — אפשר לבחור תוספות ולראות מחיר מעודכן בכל שלב:\n${lead.linkUrl}`
          : `הנה שוב הקישור האישי שלך להצעת המחיר:\n${lead.linkUrl}`;
        return { confirmationText: text };
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
