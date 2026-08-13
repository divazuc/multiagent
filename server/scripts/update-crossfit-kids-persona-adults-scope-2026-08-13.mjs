// Owner feedback 2026-08-13 07:32: "מה עלויות החוג" got the adult-programs
// Sali referral volunteered into the answer. Rule: EVERY question is about the
// kids program by default; adults/Sali surface ONLY when explicitly asked.
// Surgical persona.style_notes edit — replaces the adults sentence with a
// default-scope + explicit-ask version. Idempotent (checks for the new marker).
import { supabase } from '../lib/supabase.js';

const BIZ = 'f53bdccc-e62d-45f8-8c08-eee5594ce221';
const OLD = 'כל שאלה על חוגים/מנויים/אימונים למבוגרים: לענות בדיוק לפי תשובת המאגר על מבוגרים (סאלי מטפלת בזה), לבקש שם וטלפון, וכשנמסרו — לאשר שהפרטים הועברו לסאלי ולתעד אותם.';
const NEW = 'ברירת המחדל תמיד: כל שאלה — מחירים, שעות, הרשמה, או "החוג" סתם — עוסקת בחוג הילדים בלבד. אסור להזכיר חוגי מבוגרים, את סאלי או "אני אבדוק" לגבי מבוגרים כשלא שאלו על זה במפורש, ואסור לבקש פרטי קשר בגלל נושא שהלקוח לא העלה. רק כששואלים במפורש על חוג/מנוי/אימון למבוגרים: לענות בדיוק לפי תשובת המאגר על מבוגרים (סאלי מטפלת בזה), לבקש שם וטלפון, וכשנמסרו — לאשר שהפרטים הועברו לסאלי ולתעד אותם.';

const { data: row, error: readErr } = await supabase.from('business_profiles')
  .select('persona').eq('business_id', BIZ).maybeSingle();
if (readErr || !row) { console.error('read failed:', readErr?.message ?? 'no row'); process.exit(1); }

const notes = row.persona?.style_notes ?? '';
if (notes.includes('ברירת המחדל תמיד')) { console.log('already applied — nothing to do'); process.exit(0); }
if (!notes.includes(OLD)) { console.error('expected sentence not found in style_notes — aborting, manual review needed'); process.exit(1); }

const persona = { ...row.persona, style_notes: notes.replace(OLD, NEW) };
const { error } = await supabase.from('business_profiles')
  .update({ persona, updated_at: new Date().toISOString() }).eq('business_id', BIZ);
if (error) { console.error('update failed:', error.message); process.exit(1); }

const { data: verify } = await supabase.from('business_profiles')
  .select('persona').eq('business_id', BIZ).maybeSingle();
console.log('applied:', verify?.persona?.style_notes?.includes('ברירת המחדל תמיד') ? 'OK' : 'VERIFY FAILED');
