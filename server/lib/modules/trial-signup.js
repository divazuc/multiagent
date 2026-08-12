// Trial-signup capture — the CrossFit Kids tenant's job #1 (v1), but written
// as a generic module: any class/program business can enable it via
// business_modules like every other module.
//
// The bot collects, IN CHAT: the parent's name, the kid's name + age, and a
// preferred day — then confirms to the customer with one pinned line and
// relays a structured summary to the business's escalation contact through
// the EXISTING relay (lib/relay/index.js#raiseEscalation). No new delivery
// mechanism, no new tables: the escalation row is the durable record and the
// rep template is the notification, exactly as for any other escalation.
//
// Same iron rule as the booster module: the customer's PHONE never rides the
// action payload — it is the conversation's own session_id, known by the
// channel, never by the model. The schema has no phone field at all.
import { z } from 'zod';

// Relay seam — identical convention to booster.js's _setRelayForTest: the
// relay pulls in supabase-touching modules that tests must never load, so it
// is lazy-imported and injectable.
let relayRaise = null;
export function _setRelayForTest(fn) { relayRaise = fn; }
async function raiseRelay(args) {
  const raise = relayRaise ?? (await import('../relay/index.js')).raiseEscalation;
  return raise(args);
}

// Pinned copy (mission spec). replaceResponse — this line IS the reply; the
// model's own text alongside it could improvise a date or a promise the
// coach never made.
const CONFIRM_REPLY = 'רשמתי! המאמנת תחזור אליכם לתיאום סופי 🙂';

const CONTEXT = `## רישום לאימון ניסיון
כשהורה מתעניין באימון ניסיון — המטרה שלך היא לאסוף בשיחה, בטון חם וקצר, את הפרטים הבאים:
1. שם ההורה
2. שם הילד/ה והגיל
3. יום מועדף לאימון (או "גמיש")
אל תבקש/י מספר טלפון — הוא מזוהה אוטומטית מהשיחה. שאל/י שאלה אחת בכל הודעה, אל תחזור/י על שאלה שכבר נענתה בשיחה.
כשיש לך את הפרטים (לפחות שם ההורה ושם הילד/ה) — הוסף/י בסוף התשובה שורה נפרדת בפורמט המדויק:
<<ACTION:trial_signup.submit_trial_request{"parent_name":"...","child_name":"...","child_age":"...","preferred_day":"..."}>>
השדות child_age ו-preferred_day הם אופציונליים — אם ההורה לא מסר אותם אחרי ששאלת פעם אחת, שלח/י את הפעולה בלעדיהם במקום להתעכב.
המערכת מעבירה את הפרטים למאמנת ועונה להורה אישור קבוע מיד אחרי השורה הזאת — אל תבטיח/י מועד ספציפי ואל תאשר/י רישום בעצמך; רק המאמנת סוגרת מועד סופית.`;

// Everything beyond parent+child is UNFAILABLE (.catch(undefined)):
// executeModuleAction answers a rejected parse with invalid_payload and no
// text, so an over-strict field would cost the parent the whole confirmation.
// The coach completes anything missing on the follow-up call.
const submitSchema = z.object({
  parent_name: z.string().trim().min(1),
  child_name: z.string().trim().min(1),
  child_age: z.union([z.string(), z.number()]).transform(v => String(v).trim()).optional().catch(undefined),
  preferred_day: z.string().trim().min(1).optional().catch(undefined),
  note: z.string().trim().min(1).optional().catch(undefined),
});

export function buildTrialSummary(payload, sessionCtx) {
  const lines = [
    'בקשת אימון ניסיון חדשה 🐉',
    `הורה: ${payload.parent_name}`,
    `ילד/ה: ${payload.child_name}${payload.child_age ? ` (גיל ${payload.child_age})` : ''}`,
    `יום מועדף: ${payload.preferred_day ?? 'לא צוין — לתאם טלפונית'}`,
    `טלפון ההורה: ${sessionCtx?.session_id ?? 'לא ידוע'}`,
  ];
  if (payload.note) lines.push(`הערה: ${payload.note}`);
  return lines.join('\n');
}

const trialSignupModule = {
  key: 'trial_signup',
  name: 'רישום לאימון ניסיון',
  portalVisible: false, // v1: not shown in the client portal
  settingsSchema: z.object({}).passthrough(),
  defaultSettings: {},

  async contextProvider() { return CONTEXT; },

  actions: {
    submit_trial_request: {
      schema: submitSchema,
      async handler(business, _row, payload, sessionCtx) {
        const summary = buildTrialSummary(payload, sessionCtx);
        try {
          const relayed = await raiseRelay({
            business,
            session_id: sessionCtx?.session_id,
            question: summary,
            reason: 'trial_signup',
          });
          if (!relayed) {
            // Known, accepted v1 gap (same shape as booster F1): with
            // WHATSAPP_ESCALATION_TEMPLATE unset or no business contact, the
            // owner is not pinged — but the payload is never lost: the engine
            // logs every executed action into module_events, and this error
            // makes the miss visible in the logs. The parent still gets the
            // pinned confirmation; the follow-up is the operator's problem,
            // never the customer's.
            console.error(`[trial-signup] relay did not reach the owner for ${business?.id} — details are in module_events`);
          }
        } catch (e) {
          console.error('[trial-signup] relay failed — the parent still gets the confirmation:', e.message);
        }
        // Leads-module bookkeeping: a successful signup is the 'נרשם לניסיון'
        // signal — advance the lead and bank the structured fields on its row.
        // This handler is the one place that knows the action succeeded (the
        // engine already validated the payload), which is why the hook lives
        // here and not in the engine. Awaited so the write lands before the
        // confirmation, but recordTrialSignup gates itself on the `leads`
        // module and never throws (lib/leads.js) — like the relay above,
        // nothing here may cost the parent the confirmation.
        try {
          const { recordTrialSignup } = await import('../leads.js');
          await recordTrialSignup({
            businessId: business?.id, phone: sessionCtx?.session_id, fields: payload,
          });
        } catch (e) {
          console.error('[trial-signup] lead bookkeeping failed — the parent still gets the confirmation:', e.message);
        }
        return { confirmationText: CONFIRM_REPLY, replaceResponse: true };
      },
    },
  },

  adminUI: { fields: [] },
};

export default trialSignupModule;
