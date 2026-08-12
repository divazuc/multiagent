// Configure the CrossFit Kids trial-reminder pipeline: point the leads module
// at the registration Google Sheet, and (once the owner approves the copy)
// flip the reminders safety switch.
//
//   node --env-file=.env.local scripts/configure-kids-trial-reminders.mjs --sheet <fileId> [--gid <gid>] [--enable]
//
//   --sheet   Drive file id of the trial-form sheet (from the sheet URL:
//             docs.google.com/spreadsheets/d/<fileId>/…). Required.
//   --gid     optional tab gid (default: the first tab)
//   --enable  set reminders_enabled=true — WITHOUT it the morning run stays a
//             logged dry-run (the safety default; see lib/trial-reminders.js)
//
// Idempotent, and MERGES into existing settings rather than replacing them —
// rerunning with --enable after an earlier --sheet-only run keeps the sheet.
// Mirrors enable-leads-crossfit-kids.mjs (same table, same onConflict).
import { supabase } from '../lib/supabase.js';

const BIZ = 'f53bdccc-e62d-45f8-8c08-eee5594ce221'; // קרוספיט קידס — הדרקונים

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : (args[i + 1]?.startsWith('--') ? true : args[i + 1] ?? true);
};
const sheetId = flag('sheet');
const gid = flag('gid');
const enable = args.includes('--enable');

if (!sheetId || sheetId === true) {
  console.error('usage: node scripts/configure-kids-trial-reminders.mjs --sheet <fileId> [--gid <gid>] [--enable]');
  process.exit(1);
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
  reminders_enabled: enable ? true : (existing?.settings?.reminders_enabled ?? false),
};

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
  console.log('[configure-kids-trial-reminders] NOTE: reminders_enabled=false — the 09:00 run is a logged DRY-RUN until you rerun with --enable.');
}
