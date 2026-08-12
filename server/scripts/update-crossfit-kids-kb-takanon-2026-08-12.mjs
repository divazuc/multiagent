// KB enrichment from the 2026/27 kids תקנון draft (owner upload, 2026-08-12).
// Only FINALIZED facts (no yellow-fill placeholders). Client-facing tone: soft
// and representative; legal fine print defers to the full תקנון / the coach.
// Idempotent upsert-by-question + knowledge resync.
import { supabase } from '../lib/supabase.js';

const BIZ = 'f53bdccc-e62d-45f8-8c08-eee5594ce221';

const ROWS = [
  ['החוג', 'כמה פעמים בשבוע מתאמנים?',
   'פעמיים בשבוע — בימים ראשון ורביעי. השעות לפי הקבוצה שאליה משובצים.'],
  ['החוג', 'כמה מפגשים יש בשנה?',
   'התוכנית השנתית כוללת 81 מפגשים, לפי לוח פעילות שמתפרסם מראש לפני תחילת השנה (מספר המפגשים משתנה מחודש לחודש בגלל חגים).'],
  ['מחירים', 'כמה עולה החוג לשנה?',
   'העלות היא 400 ₪ לחודש למשך 10 חודשי פעילות — 4,000 ₪ לשנת הפעילות. יש מסלול אחד, והתשלום מתחלק לעשרה חיובים חודשיים שווים.'],
  ['מחירים', 'למה התשלום קבוע גם בחודש עם חגים?',
   'התוכנית היא שנתית — 81 מפגשים לאורך השנה — והמחיר השנתי מתחלק לעשרה תשלומים שווים לנוחות. לכן חודש עם חגים וחודש מלא עולים אותו דבר, והכל מאוזן ברמה השנתית. לוח הפעילות המלא מתפרסם מראש.'],
  ['הרשמה', 'איך נרשמים לחוג עצמו?',
   'ההרשמה לתוכנית נעשית דרך אפליקציית BoostApp, אחרי אישור התקנון. משובצים לקבוצה קבועה לכל השנה — אין צורך להירשם לכל מפגש בנפרד.'],
  ['הרשמה', 'אפשר להצטרף באמצע השנה?',
   'ההרשמה נסגרת ב-1.9 עם פתיחת השנה, כי התוכנית מדורגת וכל שלב נבנה על הקודם. במקרים מיוחדים ההנהלה יכולה לאשר הצטרפות מאוחרת אם יש מקום מתאים — שווה לדבר עם המאמנת.'],
  ['ביטולים', 'מה מדיניות הביטול?',
   'אפשר לבטל בלי דמי ביטול עד ה-30.11 (בהודעה מוקדמת של 30 יום — החיוב האחרון הוא דצמבר). מינואר והלאה ההרשמה היא עד סוף השנה, אבל הערך לא הולך לאיבוד: אפשר להעביר את יתרת המנוי לאח/ות או להמיר אותו למנוי מבוגר לאחד ההורים — בלי שום תוספת. חוץ מזה, יש גם ביטול חרטה תוך 14 יום מההרשמה, ובמצב רפואי שמונע השתתפות או מעבר דירה רחוק — ההשתתפות והחיוב מופסקים בכל שלב, בלי דמי יציאה.'],
  ['ביטולים', 'מה קורה אם הילד מפסיק באמצע?',
   'לא מאבדים את הערך — אפשר להעביר את יתרת המנוי לאח או אחות, או להמיר אותו למנוי מבוגר לאחד ההורים, בלי תוספת תשלום. המאמנת תלווה אתכם בתהליך.'],
  ['היעדרויות', 'מה קורה אם הילד מפספס אימון?',
   'היעדרות לא מזכה בהחזר, אבל כשיש אפשרות תפעולית המועדון משתדל להציע השלמה בקבוצה מקבילה שמתאימה לגיל ולרמה — בתיאום מראש דרך BoostApp ולפי מקום פנוי.'],
  ['היעדרויות', 'הילד חולה תקופה ארוכה — מה עושים?',
   'בהיעדרות רפואית של יותר מ-30 יום רצופים (עם אישור רפואי) אפשר להקפיא את המנוי, והחיובים נדחים בהתאם. פונים למאמנת והיא תסדר.'],
  ['בריאות ובטיחות', 'מה צריך למלא לפני שמתחילים?',
   'שאלון רפואי עם הצהרת בריאות והסכמת הורה בכתב. האימונים מועברים על ידי מדריך מוסמך לאימון ילדים ונוער, והקבוצות קטנות ומחולקות לפי גיל ורמה.'],
  ['הגעה ואיסוף', 'אפשר להישאר לצפות באימון?',
   'מבקשים מההורים לא לשהות בשטח האימון בזמן הפעילות — אפשר להמתין בבר הקפה או לנצל את הזמן לאימון עצמי. חשוב להגיע בזמן: איחור של יותר מ-10 דקות לא מאפשר כניסה לשיעור, מטעמי בטיחות.'],
  ['החוג', 'מתי אין פעילות?',
   'לפי לוח שנת הפעילות שמתפרסם מראש: אין פעילות בחגי ישראל, ערבי חג וימי זיכרון. בחול המועד ובחנוכה יש פעילות כרגיל (ייתכנו התאמות בשעות, בעדכון מראש באפליקציה).'],
];

const { data: existing, error } = await supabase.from('knowledge_items')
  .select('id, question').eq('business_id', BIZ);
if (error) { console.error(error.message); process.exit(1); }
const byQ = new Map((existing ?? []).map(r => [r.question, r.id]));

for (const [c, q, a] of ROWS) {
  if (byQ.has(q)) {
    const { error: e } = await supabase.from('knowledge_items')
      .update({ answer: a, category: c, is_active: true, suggested: false }).eq('id', byQ.get(q));
    console.log(e ? `UPDATE FAILED ${q}: ${e.message}` : `updated: ${q}`);
  } else {
    const { error: e } = await supabase.from('knowledge_items').insert({
      business_id: BIZ, category: c, question: q, answer: a,
      language: 'he', archetypes: [], is_active: true, suggested: false,
    });
    console.log(e ? `INSERT FAILED ${q}: ${e.message}` : `inserted: ${q}`);
  }
}

const { data: items } = await supabase.from('knowledge_items')
  .select('question, answer, category').eq('business_id', BIZ).eq('is_active', true).order('category');
const grouped = (items ?? []).reduce((a, i) => { (a[i.category] ??= []).push(`Q: ${i.question}\nA: ${i.answer}`); return a; }, {});
const faq_summary = Object.entries(grouped).map(([c, qs]) => `[${c}]\n${qs.join('\n\n')}`).join('\n\n---\n\n');
await supabase.from('business_profiles')
  .update({ knowledge: { faq_summary, synced_at: new Date().toISOString() }, updated_at: new Date().toISOString() })
  .eq('business_id', BIZ);
console.log(`resynced: ${items?.length ?? 0} active items`);
