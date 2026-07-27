// Read-only probe: what free slots does the calendar module actually compute
// for a business, against its real connected Google calendar?
//
//   cd server && node --env-file=.env.local scripts/check-calendar-slots.js <business_id>
//
// Touches nothing: freeBusy is a read, and no event is created.
import { supabase } from '../lib/supabase.js';
import calendarModule from '../lib/modules/calendar/index.js';

const businessId = process.argv[2];
if (!businessId) {
  console.error('usage: node --env-file=.env.local scripts/check-calendar-slots.js <business_id>');
  process.exit(1);
}

const { data: row, error } = await supabase
  .from('business_modules')
  .select('*')
  .eq('business_id', businessId)
  .eq('module_key', 'calendar')
  .maybeSingle();

if (error) { console.error('load failed:', error.message); process.exit(1); }
if (!row) { console.error('no calendar module row for', businessId); process.exit(1); }

console.log('enabled :', row.enabled);
console.log('status  :', row.status);
const s = row.settings ?? {};
console.log('duration:', s.duration_min, 'buffer:', s.buffer_min, 'notice(h):', s.min_notice_hours);
console.log('weekly  :', JSON.stringify(s.weekly));

try {
  const slots = await calendarModule._computeCurrentSlots(row);
  console.log(`\nfree slots computed: ${slots.length}`);
  for (const slot of slots.slice(0, 12)) console.log('  ', JSON.stringify(slot));
  if (!slots.length) console.log('  (none — check the weekly windows, the notice window, or a fully busy calendar)');
} catch (e) {
  console.error('\ncompute failed:', e.message);
  if (e.code) console.error('code:', e.code);
  process.exit(1);
}
