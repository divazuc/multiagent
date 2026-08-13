// Sim finding #2 run (2026-08-13): on a direct "אני מדברת עם בוט?" Noa dodged
// instead of the owner's scripted honest answer. The identity text allowed
// "answer in this spirit" — tightened to forbid dodging the direct question.
import { supabase } from '../lib/supabase.js';
const BIZ = 'f53bdccc-e62d-45f8-8c08-eee5594ce221';
const ADDON = ' כששואלים אותך ישירות אם את בוט/אנושית — אסור להתחמק או לענות מסביב: עונים בכנות לפי התסריט הזה, ואז ממשיכים בשיחה.';
const { data: row } = await supabase.from('business_profiles')
  .select('persona').eq('business_id', BIZ).maybeSingle();
if (row.persona?.identity?.includes('אסור להתחמק')) { console.log('already applied'); process.exit(0); }
const persona = { ...row.persona, identity: (row.persona?.identity ?? '') + ADDON };
const { error } = await supabase.from('business_profiles')
  .update({ persona, updated_at: new Date().toISOString() }).eq('business_id', BIZ);
console.log(error ? 'FAILED: ' + error.message : 'identity: no-dodge rule appended');
