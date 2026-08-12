// Owner-dictated KB enrichment for CrossFit Kids (Diva, 2026-08-12 15:54):
//   · trial-signup policy: FORM FIRST — always drive to the signup form link;
//     open dates are visible there; no open date → fill the form anyway and
//     the coach follows up when a date opens. Never leave it open-ended.
//   · pricing is now a published fact (400 ILS/month/child, personal
//     subscription) — the price guardrail is RELAXED to KB-facts-only
//     (discounts/special cases still escalate).
//   · season: Sep 1 → Jun 30 (10 activity months); Sundays + Wednesdays,
//     hours per group; minimum age: first grade / 6+.
//   · tone: fewer emojis — not every message ends with a smiley.
// Idempotent: upserts by question, prints every action. Reruns are safe.
import { supabase } from '../lib/supabase.js';

const BIZ = 'f53bdccc-e62d-45f8-8c08-eee5594ce221';
const FORM = 'https://crossfit-hadrakonim.com/trial';

// canonical rows — match[] are substrings used to find an existing row
// (including the seed's pending [לאישור דיוה] rows) whose question differs.
const ROWS = [
  {
    c: 'אימון ניסיון', q: 'מתי אימון הניסיון הקרוב?', match: ['אימון הניסיון', 'ניסיון הקרוב'],
    a: `נרשמים בטופס ההרשמה: ${FORM} — אם יש מועדים פתוחים, רואים אותם שם ובוחרים מועד (אפשר גם להירשם לשניהם). אם אין כרגע מועד פתוח — ממלאים את הטופס בכל מקרה, והמאמנת חוזרת אליכם לתיאום ברגע שנפתח מועד. הצעד הראשון הוא תמיד מילוי הטופס.`,
  },
  {
    c: 'מחירים', q: 'כמה עולה החוג?', match: ['כמה עולה החוג', 'מחיר החוג', 'עלות החוג'],
    a: '400 ₪ לחודש לילד. המנוי אישי.',
  },
  {
    c: 'החוג', q: 'באילו ימים מתקיימים האימונים?', match: ['באילו ימים', 'מתי מתקיימים האימונים', 'ימי האימונים'],
    a: 'האימונים מתקיימים בימים ראשון ורביעי. השעות — בהתאם לקבוצה שנבחרת.',
  },
  {
    c: 'החוג', q: 'מתי מתחילה העונה?', match: ['מתחילה העונה', 'תחילת העונה', 'מחזור הפעילות'],
    a: 'מחזור הפעילות של החוג: מ-1 בספטמבר עד 30 ביוני — 10 חודשי פעילות.',
  },
  {
    c: 'החוג', q: 'מאיזה גיל אפשר להצטרף?', match: ['מאיזה גיל', 'איזה גילאים', 'גיל מינימלי'],
    a: 'מכיתה א׳ (גיל 6) ומעלה. לצערנו אין כרגע אפשרות לקיים אימונים לילדים צעירים יותר — זה לא האימון שמתאים להם בגיל הזה.',
  },
];

const { data: existing, error: readErr } = await supabase.from('knowledge_items')
  .select('id, question, category, is_active, suggested').eq('business_id', BIZ);
if (readErr) { console.error('read failed:', readErr.message); process.exit(1); }

for (const r of ROWS) {
  const hit = (existing ?? []).find(row =>
    row.question === r.q || r.match.some(m => row.question.includes(m)));
  if (hit) {
    const { error } = await supabase.from('knowledge_items')
      .update({ question: r.q, answer: r.a, category: r.c, is_active: true, suggested: false })
      .eq('id', hit.id);
    console.log(error ? `UPDATE FAILED "${r.q}": ${error.message}`
      : `updated + activated: "${hit.question}"${hit.question !== r.q ? ` → "${r.q}"` : ''}`);
  } else {
    const { error } = await supabase.from('knowledge_items').insert({
      business_id: BIZ, category: r.c, question: r.q, answer: r.a,
      language: 'he', archetypes: [], is_active: true, suggested: false,
    });
    console.log(error ? `INSERT FAILED "${r.q}": ${error.message}` : `inserted: "${r.q}"`);
  }
}

// Persona + guardrails: fewer emojis, form-first policy, prices from KB allowed.
const { data: prof, error: pErr } = await supabase.from('business_profiles')
  .select('persona, guardrails').eq('business_id', BIZ).single();
if (pErr) { console.error('profile read failed:', pErr.message); process.exit(1); }

const persona = { ...prof.persona,
  emoji_style: 'minimal',
  style_notes: 'הודעות קצרות. אמפתיה להתלבטויות של הורים (ילד ביישן, לא ספורטיבי). ' +
    'אימוג׳י במשורה — לא לסיים כל הודעה באימוג׳י; מקסימום אחד פה ושם כשזה באמת מוסיף. ' +
    'שאלות על אימון ניסיון: קודם כל להפנות לטופס ההרשמה — ' + FORM + ' — ולא להשאיר את זה פתוח. ' +
    'לעולם לא להמציא עובדות שאינן במאגר.',
};
const guardrails = { ...prof.guardrails,
  escalation_points: (prof.guardrails.escalation_points ?? [])
    .filter(p => !p.includes('מחיר'))
    .concat(['בקשת הנחה, מבצע או תנאי תשלום מיוחדים']),
  forbidden_topics: (prof.guardrails.forbidden_topics ?? [])
    .filter(p => !p.startsWith('נקיבת מחיר'))
    .concat(['מחירים שאינם במאגר הידע — המחיר היחיד שמותר לצטט הוא מהמאגר; הנחות ומבצעים רק דרך המאמנת']),
  forbidden_custom:
    'מחיר מותר לצטט רק אם הוא מופיע במאגר הידע, כלשונו. הנחות, מבצעים או תנאים מיוחדים — תמיד "אני אבדוק עם המאמנת ונחזור אליכם". ' +
    'אסור לאשר רישום או מועד סופי — הניסוח הוא תמיד "המאמנת תחזור אליכם לתיאום סופי". ' +
    'לענות רק מעובדות מאגר הידע — לעולם לא להמציא שעות, תאריכים, גילאים או תנאים.',
};
const { error: wErr } = await supabase.from('business_profiles')
  .update({ persona, guardrails, updated_at: new Date().toISOString() })
  .eq('business_id', BIZ);
console.log(wErr ? 'profile update failed: ' + wErr.message : 'persona+guardrails updated (minimal emojis, form-first, KB prices allowed)');

// Re-sync active KB into business_profiles.knowledge (mirrors POST /knowledge/sync).
const { data: items } = await supabase.from('knowledge_items')
  .select('question, answer, category').eq('business_id', BIZ).eq('is_active', true).order('category');
const grouped = (items ?? []).reduce((acc, item) => {
  (acc[item.category] ??= []).push(`Q: ${item.question}\nA: ${item.answer}`);
  return acc;
}, {});
const faq_summary = Object.entries(grouped).map(([cat, qs]) => `[${cat}]\n${qs.join('\n\n')}`).join('\n\n---\n\n');
const { error: sErr } = await supabase.from('business_profiles')
  .update({ knowledge: { faq_summary, synced_at: new Date().toISOString() }, updated_at: new Date().toISOString() })
  .eq('business_id', BIZ);
console.log(sErr ? 'sync failed: ' + sErr.message : `knowledge sync: ${items?.length ?? 0} active items`);

const pending = (await supabase.from('knowledge_items').select('question').eq('business_id', BIZ).eq('suggested', true)).data ?? [];
console.log('still pending approval:', pending.length ? pending.map(p => `"${p.question}"`).join(' · ') : 'none');
