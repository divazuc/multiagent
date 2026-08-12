// Configure the CrossFit Kids trial-reminder pipeline: point the leads module
// at the registration Google Sheet, seed the OWNER-APPROVED reminder copy,
// and step through the three safety states (dry-run → test-redirect → live).
//
//   node --env-file=.env.local scripts/configure-kids-trial-reminders.mjs --sheet <fileId> [--gid <gid>] \
//     [--test-recipient <phone>|off] [--copy <text>] [--enable]
//
//   --sheet           Drive file id of the trial-form sheet (from the sheet URL:
//                     docs.google.com/spreadsheets/d/<fileId>/…). Required.
//   --gid             optional tab gid (default: the first tab)
//   --test-recipient  redirect EVERY reminder to this number (test mode — no
//                     real lead can be messaged). Pass `off` to clear it and
//                     go live. Accepts 05X… or 972… forms.
//   --copy            override the reminder copy; DEFAULT is the owner-approved
//                     kids copy baked in below ({שעה} = the trial hour, whose
//                     phrase drops cleanly when the hour is unknown)
//   --enable          set reminders_enabled=true — WITHOUT it the morning run
//                     stays a logged dry-run (the safety default)
//
// Idempotent, and MERGES into existing settings rather than replacing them —
// rerunning with --enable after an earlier --sheet-only run keeps the sheet.
// Mirrors enable-leads-crossfit-kids.mjs (same table, same onConflict).
import { supabase } from '../lib/supabase.js';

const BIZ = 'f53bdccc-e62d-45f8-8c08-eee5594ce221'; // קרוספיט קידס — הדרקונים

// The owner's approved copy, verbatim (only {שעה} varies; no child name).
// lib/trial-reminders.js#buildReminderText drops " בשעה {שעה}" cleanly when
// the hour is unknown — "…קידס 🐉 היום. כתובתנו…".
const KIDS_REMINDER_COPY =
  'בוקר טוב! מזכירה לך שנרשמת לאימון נסיון בקרוספיט הדרקונים קידס 🐉 היום בשעה {שעה}. כתובתנו: אילן רמון 5, נס ציונה. נתראה! במידה ואין באפשרותכם להגיע נשמח לעדכון, תודה';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : (args[i + 1]?.startsWith('--') ? true : args[i + 1] ?? true);
};
const sheetId = flag('sheet');
const gid = flag('gid');
const copy = flag('copy');
const testRecipientRaw = flag('test-recipient');
const enable = args.includes('--enable');

if (!sheetId || sheetId === true) {
  console.error('usage: node scripts/configure-kids-trial-reminders.mjs --sheet <fileId> [--gid <gid>] [--test-recipient <phone>|off] [--copy <text>] [--enable]');
  process.exit(1);
}

// '052-000 0000' / '+972520000000' → '972520000000'
function normalizePhone(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '972' + d.slice(1);
  return /^\d{10,15}$/.test(d) ? d : null;
}

const { data: existing, error: readErr } = await supabase.from('business_modules')
  .select('enabled, settings').eq('business_id', BIZ).eq('module_key', 'leads').maybeSingle();
if (readErr) {
  console.error('[configure-kids-trial-reminders] read failed:', readErr.message);
  process.exit(1);
}

const settings = {
  ...(existing?.settings ?? {}),
  sheet_file_id: sheetId,
  ...(gid && gid !== true ? { sheet_gid: String(gid) } : {}),
  reminder_copy: (copy && copy !== true) ? copy : (existing?.settings?.reminder_copy ?? KIDS_REMINDER_COPY),
  reminders_enabled: enable ? true : (existing?.settings?.reminders_enabled ?? false),
};

// Test-redirect handling: set, keep, or clear (`off` → live sends allowed).
if (testRecipientRaw && testRecipientRaw !== true) {
  if (testRecipientRaw === 'off') {
    delete settings.reminder_test_recipient;
  } else {
    const normalized = normalizePhone(testRecipientRaw);
    if (!normalized) {
      console.error(`[configure-kids-trial-reminders] --test-recipient "${testRecipientRaw}" is not a usable phone number`);
      process.exit(1);
    }
    settings.reminder_test_recipient = normalized;
  }
}

const { error } = await supabase.from('business_modules').upsert({
  business_id: BIZ, module_key: 'leads',
  enabled: true, settings, updated_at: new Date().toISOString(),
}, { onConflict: 'business_id,module_key' });
if (error) {
  console.error('[configure-kids-trial-reminders] upsert failed:', error.message);
  process.exit(1);
}

console.log('[configure-kids-trial-reminders] leads-module settings for קרוספיט קידס:', settings);
if (!settings.reminders_enabled) {
  console.log('[configure-kids-trial-reminders] state: DRY-RUN — nothing is sent until you rerun with --enable.');
} else if (settings.reminder_test_recipient) {
  console.log(`[configure-kids-trial-reminders] state: TEST-REDIRECT — every reminder goes to ${settings.reminder_test_recipient}, no real lead can be messaged. Rerun with --test-recipient off to go live.`);
} else {
  console.log('[configure-kids-trial-reminders] state: LIVE — reminders go to real leads at the next 09:00 run.');
}
