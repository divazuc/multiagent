// Simulation findings 2026-08-13 (18_SIM_CONVERSATIONS.md), three data fixes:
// 1. escalation_points: "ביטול" caught policy QUESTIONS too — scope it to
//    actual cancellation REQUESTS (persona already draws this line; the
//    guardrail was short-circuiting before the persona could).
// 2. New KB row: pricing logic for partial attendance ("פעם אחת במקום
//    פעמיים") — was deflecting to name/phone collection.
// 3. Shy-kid KB row: written in masculine ("בדיוק בשבילו") — served verbatim
//    by the direct-KB path to a parent asking about a DAUGHTER. Neutralized.
// Idempotent. Resyncs faq_summary at the end.
import { supabase } from '../lib/supabase.js';

const BIZ = 'f53bdccc-e62d-45f8-8c08-eee5594ce221';

// 1 — escalation scoping
const { data: prof } = await supabase.from('business_profiles')
  .select('guardrails, knowledge').eq('business_id', BIZ).maybeSingle();
const guardrails = typeof prof.guardrails === 'string' ? JSON.parse(prof.guardrails) : (prof.guardrails ?? {});
const OLD_ESC = 'ביטול הרשמה, החזר כספי או הקפאה';
const NEW_ESC = 'בקשה בפועל לביטול הרשמה, החזר כספי או הקפאה — אבל שאלה כללית על מדיניות הביטול היא לא הסלמה: עונים עליה במלואה מהמאגר';
if (Array.isArray(guardrails.escalation_points) && guardrails.escalation_points.includes(OLD_ESC)) {
  guardrails.escalation_points = guardrails.escalation_points.map(p => p === OLD_ESC ? NEW_ESC : p);
  const { error } = await supabase.from('business_profiles')
    .update({ guardrails, updated_at: new Date().toISOString() }).eq('business_id', BIZ);
  console.log(error ? 'esc FAILED: ' + error.message : 'escalation_points: scoped to actual requests');
} else console.log('escalation_points: already applied');

// 2 — partial-attendance pricing row (core: it's the once-a-week family)
const Q2 = 'אם מגיעים רק פעם בשבוע, למה לשלם מחיר מלא?';
const A2 = 'המנוי בנוי כתוכנית שנתית של שני אימונים בשבוע — המקום של הילד שמור בקבוצה בשני המפגשים, והתקדמות התוכנית מבוססת עליהם. לכן אין מסלול חלקי והמחיר אחיד. אם יוצא לפספס אימון פה ושם — כשיש אפשרות, המועדון משתדל להציע השלמה בקבוצה מקבילה, בתיאום מראש.';
const { data: ex2 } = await supabase.from('knowledge_items')
  .select('id').eq('business_id', BIZ).eq('question', Q2).maybeSingle();
if (!ex2) {
  const { error } = await supabase.from('knowledge_items').insert({
    business_id: BIZ, category: 'מחירים', question: Q2, answer: A2,
    language: 'he', archetypes: ['core'], is_active: true, suggested: false,
  });
  console.log(error ? 'row2 FAILED: ' + error.message : 'pricing-logic row inserted (core)');
} else console.log('pricing-logic row: exists');

// 3 — neutralize the shy-kid row (find by its masculine opener)
const { data: shy } = await supabase.from('knowledge_items')
  .select('id, question, answer').eq('business_id', BIZ).ilike('answer', '%בדיוק בשבילו%');
for (const r of shy ?? []) {
  const answer = r.answer.replace('בדיוק בשבילו', 'זה בדיוק המקום בשביל ילדים כאלה');
  const { error } = await supabase.from('knowledge_items').update({ answer }).eq('id', r.id);
  console.log(error ? 'row3 FAILED: ' + error.message : `neutralized: ${r.question}`);
}
if (!shy?.length) console.log('shy-kid row: already neutral');

// resync
const { data: items } = await supabase.from('knowledge_items')
  .select('question, answer, category').eq('business_id', BIZ).eq('is_active', true).order('category');
const grouped = (items ?? []).reduce((a, i) => { (a[i.category] ??= []).push(`Q: ${i.question}\nA: ${i.answer}`); return a; }, {});
const faq_summary = Object.entries(grouped).map(([c, qs]) => `[${c}]\n${qs.join('\n\n')}`).join('\n\n---\n\n');
await supabase.from('business_profiles')
  .update({ knowledge: { ...(typeof prof.knowledge === 'string' ? JSON.parse(prof.knowledge) : prof.knowledge ?? {}), faq_summary, synced_at: new Date().toISOString() }, updated_at: new Date().toISOString() })
  .eq('business_id', BIZ);
console.log(`resynced ${items?.length ?? 0} rows`);
