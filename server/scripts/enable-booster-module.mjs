// One-off: enable the `booster` module (create_quote_lead / resend_quote_link
// conversation actions, task-16 of the divazuc <-> bot integration) for Diva's
// own business (the "Diva Ost" divaost bot — same BIZ id used by
// seed-divaost-faq.mjs / update-divaost-from-spec.mjs). No other business
// should get this module: it talks to the booster with a single shared
// bearer secret scoped to Diva's own booster.divdev.co account.
//
// Mirrors lib/studio.js's updateModule() upsert exactly (same table, same
// onConflict target) so this is indistinguishable from toggling the module on
// via the admin UI's per-business module screen — just done here because
// there is no admin-UI settings payload to fill in for this module (no
// OAuth, no per-business config: settings stays `{}`).
//
//   node --env-file=.env.local scripts/enable-booster-module.mjs
import { supabase } from '../lib/supabase.js';

const BIZ = '86efa161-9af8-45c1-924f-6ec39850f114'; // Diva Ost

const { error } = await supabase.from('business_modules').upsert({
  business_id: BIZ, module_key: 'booster',
  enabled: true, settings: {}, updated_at: new Date().toISOString(),
}, { onConflict: 'business_id,module_key' });

if (error) {
  console.error('[enable-booster-module] upsert failed:', error.message);
  process.exit(1);
}

const { data, error: readErr } = await supabase.from('business_modules')
  .select('business_id, module_key, enabled, status, updated_at')
  .eq('business_id', BIZ).eq('module_key', 'booster').maybeSingle();

if (readErr) {
  console.error('[enable-booster-module] verify read failed:', readErr.message);
  process.exit(1);
}

console.log('[enable-booster-module] booster module enabled for Diva Ost:', data);
