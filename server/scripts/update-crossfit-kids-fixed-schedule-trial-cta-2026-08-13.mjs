// Owner feedback 2026-08-13 07:44 (live test): Noa offered "יום מועדף לכם,
// או גמיש?" — invented day-choice flexibility. Facts: the subscription is
// ALWAYS both weekly sessions (Sun+Wed), no once-a-week track at this stage,
// hours fixed per age group. Also: CTA should gently steer to a TRIAL session
// — "try before committing to a subscription" — never aggressively.
// Three layers: KB fact row (+resync), style_notes rule, cta_style reframe.
// Idempotent: marker checks per layer.
import { supabase } from '../lib/supabase.js';

const BIZ = 'f53bdccc-e62d-45f8-8c08-eee5594ce221';

// ── Layer 1: KB fact ────────────────────────────────────────────────────────
const KB_Q = 'אפשר להגיע רק פעם בשבוע או לבחור יום?';
const KB_A = 'בשלב זה המנוי כולל תמיד את שני האימונים השבועיים — ימי ראשון ורביעי — ואין מסלול של פעם בשבוע. השעות קבועות לפי קבוצת הגיל ואינן גמישות. לפני שמתחייבים למנוי אפשר פשוט להתנסות באימון ניסיון ולהרגיש את זה.';

const { data: existing } = await supabase.from('knowledge_items')
  .select('id').eq('business_id', BIZ).eq('question', KB_Q).maybeSingle();
if (existing) {
  const { error } = await supabase.from('knowledge_items')
    .update({ answer: KB_A, category: 'החוג', is_active: true, suggested: false }).eq('id', existing.id);
  console.log(error ? `KB UPDATE FAILED: ${error.message}` : 'KB: updated');
} else {
  const { error } = await supabase.from('knowledge_items').insert({
    business_id: BIZ, category: 'החוג', question: KB_Q, answer: KB_A,
    language: 'he', archetypes: [], is_active: true, suggested: false,
  });
  console.log(error ? `KB INSERT FAILED: ${error.message}` : 'KB: inserted');
}

// resync faq_summary (same pattern as prior KB scripts)
const { data: items } = await supabase.from('knowledge_items')
  .select('question, answer, category').eq('business_id', BIZ).eq('is_active', true).order('category');
const grouped = (items ?? []).reduce((a, i) => { (a[i.category] ??= []).push(`Q: ${i.question}\nA: ${i.answer}`); return a; }, {});
const faq_summary = Object.entries(grouped).map(([c, qs]) => `[${c}]\n${qs.join('\n\n')}`).join('\n\n---\n\n');

// ── Layers 2+3: persona ─────────────────────────────────────────────────────
const { data: row, error: readErr } = await supabase.from('business_profiles')
  .select('persona, knowledge').eq('business_id', BIZ).maybeSingle();
if (readErr || !row) { console.error('persona read failed:', readErr?.message ?? 'no row'); process.exit(1); }

const persona = { ...row.persona };

const SCHEDULE_RULE = ' לוח הזמנים קבוע: המנוי הוא תמיד לשני האימונים בשבוע (ראשון ורביעי) בשעות הקבועות של קבוצת הגיל. לעולם לא להציע בחירת יום, "יום מועדף", גמישות בימים או התאמת שעות — אלה לא קיימים. אם הורה שואל על יום אחד — להסביר בחיוב שהתוכנית בנויה על שני המפגשים ושלפני התחייבות אפשר להתנסות באימון ניסיון.';
if (!persona.style_notes?.includes('לוח הזמנים קבוע:')) {
  persona.style_notes = (persona.style_notes ?? '') + SCHEDULE_RULE;
  console.log('style_notes: schedule rule appended');
} else { console.log('style_notes: already applied'); }

const NEW_CTA = 'רך ולא דוחף, אבל תמיד בכיוון אחד: אימון ניסיון. הזווית המרכזית — להתנסות לפני שמתחייבים למנוי: ברוח "נשמח לתאם שיעור ניסיון כדי שהילד יחווה אימון במועדון לפני שמחליטים על מנוי", ואז להפנות לטופס ההרשמה. להציע פעם אחת בעדינות, לא לחזור על ההצעה בכל הודעה, ובלי ניסוחים אגרסיביים כמו "רוצה שאקדם לך רישום?".';
if (persona.cta_style !== NEW_CTA) { persona.cta_style = NEW_CTA; console.log('cta_style: reframed to trial-first'); }
else { console.log('cta_style: already applied'); }

const { error: upErr } = await supabase.from('business_profiles')
  .update({
    persona,
    knowledge: { ...(row.knowledge ?? {}), faq_summary, synced_at: new Date().toISOString() },
    updated_at: new Date().toISOString(),
  }).eq('business_id', BIZ);
if (upErr) { console.error('persona update failed:', upErr.message); process.exit(1); }
console.log(`done — ${items?.length ?? 0} active KB rows resynced`);
