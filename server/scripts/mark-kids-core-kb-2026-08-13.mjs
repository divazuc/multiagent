// Owner incident 2026-08-13 08:21+08:40: retrieval blind spot — schedule and
// the trial-form link missing from context when the message shared no words
// with them ("רועי בן 7"), so Noa deflected hours she knew and collected a
// name instead of sending the signup link. Fix pair for conversation.js's
// core-KB block: (1) mark the always-needed rows with the 'core' archetype —
// they ride in the cached stable prefix from now on; (2) strengthen the
// form-first rule in persona.style_notes. Idempotent both ways.
import { supabase } from '../lib/supabase.js';

const BIZ = 'f53bdccc-e62d-45f8-8c08-eee5594ce221';

const CORE_QUESTIONS = [
  'מה שעות האימונים של כל קבוצה?',
  'לאילו גילאים מיועד החוג ואיך מחולקות הקבוצות?',
  'כמה עולה החוג לשנה?',
  'כמה פעמים בשבוע מתאמנים?',
  'אפשר להגיע רק פעם בשבוע או לבחור יום?',
];

const { data: rows, error } = await supabase.from('knowledge_items')
  .select('id, question, answer, archetypes').eq('business_id', BIZ).eq('is_active', true);
if (error) { console.error('read failed:', error.message); process.exit(1); }

let marked = 0;
for (const r of rows ?? []) {
  const isCore = CORE_QUESTIONS.includes(r.question)
    || (r.answer ?? '').includes('crossfit-hadrakonim.com/trial')
    || (r.answer ?? '').includes('אוגוסט');
  const has = Array.isArray(r.archetypes) && r.archetypes.includes('core');
  if (isCore && !has) {
    const archetypes = [...(r.archetypes ?? []), 'core'];
    const { error: e } = await supabase.from('knowledge_items').update({ archetypes }).eq('id', r.id);
    console.log(e ? `FAILED ${r.question}: ${e.message}` : `core: ${r.question}`);
    if (!e) marked++;
  }
}
console.log(`marked ${marked} new core rows (of ${rows?.length ?? 0} active)`);

const FORM_FIRST_RULE = ' תיאום אימון ניסיון נעשה אך ורק דרך טופס ההרשמה: ברגע שעולה עניין באימון ניסיון — לשלוח את קישור הטופס. לא לאסוף שם או טלפון בשיחה בתור תחליף לטופס, ולא להבטיח שהמאמנת "תחזור לתיאום" למי שעוד לא נרשם בטופס.';
const { data: prof } = await supabase.from('business_profiles')
  .select('persona').eq('business_id', BIZ).maybeSingle();
if (prof && !prof.persona?.style_notes?.includes('אך ורק דרך טופס ההרשמה')) {
  const persona = { ...prof.persona, style_notes: (prof.persona?.style_notes ?? '') + FORM_FIRST_RULE };
  const { error: e } = await supabase.from('business_profiles')
    .update({ persona, updated_at: new Date().toISOString() }).eq('business_id', BIZ);
  console.log(e ? 'persona update failed: ' + e.message : 'style_notes: form-first rule appended');
} else {
  console.log('style_notes: already applied');
}
