// Canned-answer enrichment for CrossFit Kids (Diva, 2026-08-28):
// mined from the real conversations of 12-28/8 — both the bot's answered
// turns and Diva's MANUAL WhatsApp replies (stage=coexistence rows) — so the
// stored questions now match how parents actually phrase them (the
// kb-direct-match near-exact tier only fires on close wording), and the
// answers use Diva's own manual phrasing.
//   · price/hours/location variants in the exact words parents typed
//     ("מה עלויות החוג", "כמה עולה מנוי", "מתי מתקיים החוג", "איפה זה")
//   · new topics Diva answered by hand this week: private training via Sally,
//     special-needs fit, multiple kids across age groups, what a session
//     covers, once-a-week refusal in her wording
//   · girls-group row goes in as a PENDING SUGGESTION (suggested, inactive) —
//     Diva approves in the portal; the fact needs her confirmation.
//   · "חינם באוגוסט" expiry (due 1/9): the trial-cost answer drops the month
//     qualifier, in knowledge_items AND inside the faq_summary fallback blob.
//   · clears machine-noise suggestion drafts (greetings/acks the learning
//     mechanism saved: "חחחח", "תודה", bare names...) so the portal queue
//     holds only real candidates.
// Idempotent: upserts by question, prints every action. Reruns are safe.
import { supabase } from '../lib/supabase.js';

const BIZ = 'f53bdccc-e62d-45f8-8c08-eee5594ce221';

const HOURS =
  'האימונים פעמיים בשבוע, לפי קבוצות גיל: כיתות א׳–ג׳ — ראשון ורביעי 16:45–17:30 · כיתות ד׳–ו׳ — ראשון ורביעי 16:00–16:45 · נוער (מכיתה ז׳) — שני וחמישי 16:00–16:45 או 16:45–17:30.';
const PRICE =
  'העלות היא 400 ₪ לחודש לילד (מנוי אישי), בעשרה חיובים חודשיים על פני שנת הפעילות.';
const ADDRESS = 'אנחנו ממוקמים באילן רמון 5, נס ציונה 🙂';

// canonical rows — match[] are substrings used to find an existing row whose
// question differs. Variant rows deliberately reuse the same answer text so
// every phrasing lands on the identical reply.
const ROWS = [
  // ── location, in the words parents typed on 25/8 + 28/8 ──
  { c: 'מיקום', q: 'איפה אתם נמצאים?', match: ['איפה אתם נמצאים'], a: ADDRESS },
  { c: 'מיקום', q: 'איפה זה?',          match: [],                  a: ADDRESS },
  { c: 'מיקום', q: 'מה הכתובת?',        match: ['מה הכתובת'],       a: ADDRESS },
  // ── hours variants ("מתי מתקיים החוג" asked twice on 13/8) ──
  { c: 'קבוצות ושעות', q: 'מתי מתקיים החוג?', match: ['מתי מתקיים החוג'], a: HOURS },
  { c: 'קבוצות ושעות', q: 'מה שעות החוג?',    match: ['מה שעות החוג'],    a: HOURS },
  // ── price variants (13/8: "מה עלויות החוג?", "כמה עולה מנוי?") ──
  { c: 'מחירים', q: 'מה עלויות החוג?', match: ['מה עלויות'],   a: PRICE },
  { c: 'מחירים', q: 'כמה עולה מנוי?',  match: ['כמה עולה מנוי'], a: PRICE },
  // ── once-a-week, in Diva's manual wording (22/8 + 25/8) ──
  {
    c: 'החוג', q: 'אפשר רק פעם בשבוע?', match: ['אפשר רק פעם בשבוע'],
    a: 'לצערנו החוג הוא דו-שבועי — המנוי כולל את שני האימונים השבועיים ואין מסלול של פעם בשבוע. אפשר להתנסות קודם באימון ניסיון ולהרגיש 🙂',
  },
  // ── session content, Diva's manual wording (25/8) ──
  {
    c: 'על החוג', q: 'מה עושים באימונים?', match: ['מה עושים באימונים'],
    a: 'אנחנו עובדים על טכניקה ועבודה פונקציונלית — הכל מותאם גיל ולפי קבוצות. בונים יסודות לאט, בזהירות ובהתאמה אישית לכל ילד וליכולתו 🙂',
  },
  // ── siblings across groups (asked 22/8, 23/8, 24/8) ──
  {
    c: 'על החוג', q: 'יש לי כמה ילדים בגילאים שונים — איך זה עובד?', match: ['ילדים בגילאים שונים'],
    a: 'כל ילד משתבץ לקבוצה לפי הכיתה שלו — א׳–ג׳, ד׳–ו׳ ונוער (מכיתה ז׳). האימונים מתקיימים ברצף זה אחרי זה, כך שנוח להגיע עם כמה ילדים 🙂',
  },
  // ── private training via Sally, Diva's manual answer (24/8) ──
  {
    c: 'על החוג', q: 'אפשר לתאם אימון פרטי?', match: ['אימון פרטי'],
    a: 'בטח — אימונים פרטיים נקבעים ישירות מול סאלי, בעלת המקום. אשמח להעביר לה את הפרטים שלך והיא תחזור אליך 🙂',
  },
  // ── special-needs fit, Diva's manual answer (24/8, autism inquiry) ──
  {
    c: 'על החוג', q: 'הילד שלי עם צרכים מיוחדים — החוג יכול להתאים?', match: ['צרכים מיוחדים'],
    a: 'החוג הוא קבוצתי, ומוזמנים להגיע לאימון ניסיון ולהרגיש אם זה מתאים. אם עדיף ליווי אישי — אפשר לקבוע אימון פרטי מול סאלי, בעלת המקום. אשמח להעביר לה את הפרטים שלכם 🙂',
  },
];

// Needs Diva's confirmation (she wrote "אתייעץ עם סאלי" on 23/8) — pending.
const SUGGESTED_ROWS = [
  {
    c: 'קבוצות ושעות', q: 'יש קבוצת נערות נפרדת?', match: ['קבוצת נערות'],
    a: 'לנוער מכיתה ז׳ ומעלה יש קבוצה בימי שני וחמישי. ייתכן שקבוצת הנערות תתאים יותר — אבדוק מול סאלי ואחזור אליכם 🙂',
  },
];

// Machine-noise drafts the learning mechanism saved off 12-20/8 turns —
// greetings, acks, bare names. Real candidates ("האם מתאים גם לבנות 16?",
// "מה ההגיון לשלם...") are deliberately NOT here; Diva reviews those.
const NOISE_DRAFT_QUESTIONS = [
  '🤣', '12', 'בסדר אתאם!', 'דינה', 'הודעה לפה', 'היי', 'חחחח', 'מתלהב', 'תודה',
];
const NOISE_DRAFT_PREFIXES = ['ניתן להתקשר'];

const { data: existing, error: readErr } = await supabase.from('knowledge_items')
  .select('id, question, category, is_active, suggested').eq('business_id', BIZ);
if (readErr) { console.error('read failed:', readErr.message); process.exit(1); }

async function upsert(r, { active }) {
  const hit = (existing ?? []).find(row =>
    row.question === r.q || r.match.some(m => row.question.includes(m)));
  if (hit) {
    const { error } = await supabase.from('knowledge_items')
      .update({ question: r.q, answer: r.a, category: r.c, is_active: active, suggested: !active })
      .eq('id', hit.id);
    console.log(error ? `UPDATE FAILED "${r.q}": ${error.message}`
      : `updated${active ? ' + activated' : ' (pending)'}: "${hit.question}"${hit.question !== r.q ? ` → "${r.q}"` : ''}`);
  } else {
    const { error } = await supabase.from('knowledge_items').insert({
      business_id: BIZ, category: r.c, question: r.q, answer: r.a,
      language: 'he', archetypes: [], is_active: active, suggested: !active,
    });
    console.log(error ? `INSERT FAILED "${r.q}": ${error.message}`
      : `inserted${active ? '' : ' (pending suggestion)'}: "${r.q}"`);
  }
}

for (const r of ROWS) await upsert(r, { active: true });
for (const r of SUGGESTED_ROWS) await upsert(r, { active: false });

// ── de-August the trial-cost answer (offer wording expires 1/9) ──
{
  const { error } = await supabase.from('knowledge_items')
    .update({ answer: 'אימון ניסיון — ללא עלות וללא התחייבות 🙂 נרשמים בטופס: https://crossfit-hadrakonim.com/trial (ההרשמה חובה כדי להשתתף).' })
    .eq('business_id', BIZ).eq('question', 'כמה עולה אימון הניסיון?');
  console.log(error ? `de-August UPDATE FAILED: ${error.message}` : 'de-Augusted: "כמה עולה אימון הניסיון?"');
}
{
  // same string lives inside the faq_summary fallback blob on the profile
  const { data: prof, error } = await supabase.from('business_profiles')
    .select('knowledge').eq('business_id', BIZ).maybeSingle();
  if (error || !prof) {
    console.log(`faq_summary read FAILED: ${error?.message ?? 'no profile'}`);
  } else {
    const text = JSON.stringify(prof.knowledge);
    const fixed = text.replace('אימון ניסיון במהלך חודש אוגוסט', 'אימון ניסיון');
    if (fixed === text) {
      console.log('faq_summary: no August wording found (already clean)');
    } else {
      const { error: upErr } = await supabase.from('business_profiles')
        .update({ knowledge: JSON.parse(fixed) }).eq('business_id', BIZ);
      console.log(upErr ? `faq_summary UPDATE FAILED: ${upErr.message}` : 'de-Augusted: faq_summary fallback blob');
    }
  }
}

// ── clear machine-noise suggestion drafts (inactive + suggested only) ──
for (const row of existing ?? []) {
  if (row.is_active || !row.suggested) continue;
  const isNoise = NOISE_DRAFT_QUESTIONS.includes(row.question) ||
    NOISE_DRAFT_PREFIXES.some(p => row.question.startsWith(p));
  if (!isNoise) continue;
  const { error } = await supabase.from('knowledge_items').delete().eq('id', row.id);
  console.log(error ? `DELETE FAILED "${row.question}": ${error.message}`
    : `deleted noise draft: "${row.question.replace(/\n/g, ' ⏎ ')}"`);
}

const { count } = await supabase.from('knowledge_items')
  .select('id', { count: 'exact', head: true }).eq('business_id', BIZ).eq('is_active', true);
console.log(`done. active rows for kids: ${count}`);
