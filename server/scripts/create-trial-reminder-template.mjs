// Create the Meta UTILITY template `trial_reminder_he` — the out-of-24h-window
// fallback for the morning trial-day reminder (lib/trial-reminders.js).
//
//   node --env-file=.env.local scripts/create-trial-reminder-template.mjs <waba_id>
//
// Uses the PLATFORM WhatsApp token (WHATSAPP_ACCESS_TOKEN env — same one
// wa-send.js falls back to). Prints the created template's status; Meta
// reviews utility templates asynchronously, so expect PENDING at first.
// Once APPROVED, the orchestrator sets WHATSAPP_TRIAL_REMINDER_TEMPLATE=
// trial_reminder_he on Railway — the send path stays free-form-only until
// that env exists (same gating pattern as WHATSAPP_ESCALATION_TEMPLATE).
//
// The body is the OWNER-APPROVED reminder copy, verbatim, with one variable:
// {{1}} = the trial hour (send-path fallback 'שנקבעה' → "היום בשעה שנקבעה" —
// see TEMPLATE_PARAM_FALLBACKS in lib/trial-reminders.js).

const GRAPH_API = 'https://graph.facebook.com/v21.0';

const wabaId = process.argv[2];
if (!wabaId) {
  console.error('usage: node scripts/create-trial-reminder-template.mjs <waba_id>');
  process.exit(1);
}
const token = process.env.WHATSAPP_ACCESS_TOKEN;
if (!token) {
  console.error('WHATSAPP_ACCESS_TOKEN is not set (run with --env-file=.env.local)');
  process.exit(1);
}

const template = {
  name: 'trial_reminder_he',
  language: 'he',
  category: 'UTILITY',
  components: [
    {
      type: 'BODY',
      text: 'בוקר טוב! מזכירה לך שנרשמת לאימון נסיון בקרוספיט הדרקונים קידס 🐉 היום בשעה {{1}}. כתובתנו: אילן רמון 5, נס ציונה. נתראה! במידה ואין באפשרותכם להגיע נשמח לעדכון, תודה',
      example: { body_text: [['16:00']] },
    },
  ],
};

const res = await fetch(`${GRAPH_API}/${wabaId}/message_templates`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(template),
});
const body = await res.json();

if (!res.ok) {
  // "already exists" is fine to see plainly — rerunning this script is safe.
  console.error('[create-trial-reminder-template] Graph error:', JSON.stringify(body, null, 2));
  process.exit(1);
}
console.log('[create-trial-reminder-template] created:', JSON.stringify(body, null, 2));
console.log(`[create-trial-reminder-template] status=${body.status ?? 'UNKNOWN'} — when APPROVED, set WHATSAPP_TRIAL_REMINDER_TEMPLATE=trial_reminder_he on Railway.`);
