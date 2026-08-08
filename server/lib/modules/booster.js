// Booster (divaz_booster) quote-lead module — seam 3 of the divazuc <-> bot
// integration. Lets the sales/hybrid conversation agent create a personal
// quote-building link for a customer and recover it later if lost. Diva's
// own business only (enabled per-business like every module, via
// business_modules — see docs/superpowers/sdd/2026-08-07-divazuc-flow-api-
// bot-integration/task-16-report.md for the exact enablement done).
//
// No OAuth, no per-business secrets: auth to the booster is a single shared
// bearer token read from env inside booster-client.js. contextProvider is
// therefore static text, not something computed per-row.
import { z } from 'zod';
import * as boosterClientReal from '../booster-client.js';

// Test seam — same convention as booster-webhook.js's _setSendForTest:
// production always uses the real HTTP client; tests inject a stub so
// success/idempotent/not-found paths can be asserted without a network call.
let boosterClient = boosterClientReal;
export function _setBoosterClientForTest(fake) { boosterClient = fake ?? boosterClientReal; }

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

const boosterModule = {
  key: 'booster',
  name: 'הצעת מחיר אישית (בוסטר)',
  portalVisible: false, // v1: not shown in the client portal
  settingsSchema,
  defaultSettings: settingsSchema.parse({}),

  async contextProvider() {
    return CONTEXT;
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
  },

  adminUI: { fields: [] },
};

export default boosterModule;
