// Idempotent: enable the `leads` module (ניהול לידים board — lib/leads.js,
// portal tab in wa-studio) for the CrossFit Kids tenant, the first external
// client (seed-crossfit-kids-2026-08.mjs). Safe to run any number of times —
// it upserts the same enabled row.
//
// Mirrors lib/studio.js#updateModule's upsert exactly (same table, same
// onConflict target) so this is indistinguishable from toggling the module on
// in the admin UI — done as a script because the module has no settings to
// fill in and the orchestrator runs it alongside the DDL
// (wa-studio/docs/sql/2026-08-12-leads.sql). Order does not matter: the code
// fails soft until the table exists.
//
//   node --env-file=.env.local scripts/enable-leads-crossfit-kids.mjs
import { supabase } from '../lib/supabase.js';

const BIZ = 'f53bdccc-e62d-45f8-8c08-eee5594ce221'; // קרוספיט קידס — הדרקונים

const { error } = await supabase.from('business_modules').upsert({
  business_id: BIZ, module_key: 'leads',
  enabled: true, settings: {}, updated_at: new Date().toISOString(),
}, { onConflict: 'business_id,module_key' });

if (error) {
  console.error('[enable-leads-crossfit-kids] upsert failed:', error.message);
  process.exit(1);
}

const { data, error: readErr } = await supabase.from('business_modules')
  .select('business_id, module_key, enabled, status, updated_at')
  .eq('business_id', BIZ).eq('module_key', 'leads').maybeSingle();

if (readErr) {
  console.error('[enable-leads-crossfit-kids] verify read failed:', readErr.message);
  process.exit(1);
}

console.log('[enable-leads-crossfit-kids] leads module enabled for קרוספיט קידס:', data);

// The board only fills once the table exists — remind rather than fail.
const { error: tableErr } = await supabase.from('leads').select('id').limit(1);
if (tableErr) {
  console.warn('[enable-leads-crossfit-kids] NOTE: the `leads` table is not readable yet' +
    ' — apply wa-studio/docs/sql/2026-08-12-leads.sql in the Supabase dashboard:', tableErr.message);
} else {
  console.log('[enable-leads-crossfit-kids] `leads` table reachable — board is live.');
}
