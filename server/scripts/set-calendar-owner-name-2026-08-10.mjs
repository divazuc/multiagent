// One-off (2026-08-10): set the calendar module's owner_display_name for
// Diva's own business, so the tentative-booking reply reads "שלחתי לדיוה
// לאישור הפגישה" instead of the neutral fallback. The module itself stays
// generic — the name is per-tenant settings data, exactly like
// owner_notify_phone (lib/modules/calendar/index.js#settingsSchema).
//
// Idempotent: merges into the existing settings row and re-running just
// writes the same value again. Refuses to CREATE the row — the calendar
// module must already be configured for this business.
//
//   node --env-file=.env.local scripts/set-calendar-owner-name-2026-08-10.mjs
import { supabase } from '../lib/supabase.js';

const BIZ = '86efa161-9af8-45c1-924f-6ec39850f114'; // Diva Ost
const OWNER_DISPLAY_NAME = 'דיוה';

const { data: row, error: readErr } = await supabase.from('business_modules')
  .select('business_id, module_key, settings')
  .eq('business_id', BIZ).eq('module_key', 'calendar').maybeSingle();

if (readErr) {
  console.error('[set-calendar-owner-name] read failed:', readErr.message);
  process.exit(1);
}
if (!row) {
  console.error('[set-calendar-owner-name] no calendar module row for Diva Ost — configure the calendar module first');
  process.exit(1);
}

const settings = { ...(row.settings ?? {}), owner_display_name: OWNER_DISPLAY_NAME };
const { error } = await supabase.from('business_modules')
  .update({ settings, updated_at: new Date().toISOString() })
  .eq('business_id', BIZ).eq('module_key', 'calendar');

if (error) {
  console.error('[set-calendar-owner-name] update failed:', error.message);
  process.exit(1);
}

const { data: verify } = await supabase.from('business_modules')
  .select('settings').eq('business_id', BIZ).eq('module_key', 'calendar').maybeSingle();
console.log('[set-calendar-owner-name] owner_display_name is now:',
  verify?.settings?.owner_display_name);
