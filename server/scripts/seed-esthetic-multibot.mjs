// server/scripts/seed-esthetic-multibot.mjs
//
// Seeds the multi-bot dashboard config + the knowledge-interview question
// bank into a business's draft_setup_data. Idempotent: bots are replaced
// wholesale; interview questions are appended only if their id is absent.
//
//   node --env-file=.env.local scripts/seed-esthetic-multibot.mjs <business_id>
//   node --env-file=.env.local scripts/seed-esthetic-multibot.mjs --create-scratch
import { supabase } from '../lib/supabase.js';

const BOTS = [
  { id: 'doctors', name: 'הכשרות וקורסים', icon: '🩺', color: '#6d28d9', tint: '#ede9fe',
    panel: 'פאנל 01 · 972-51-555-1111', keywords: 'קורס|רופא|הכשר|סילבוס|השתלמ|בי.?ה.?ס' },
  { id: 'treatments', name: 'טיפולים אסתטיים', icon: '💉', color: '#0d9488', tint: '#dbeafe',
    panel: 'פאנל 02 · 972-51-555-2222', keywords: null },
  { id: 'hair', name: 'השתלות שיער', icon: '💇', color: '#b45309', tint: '#fef3c6',
    panel: 'פאנל 03 · 972-51-555-3333', keywords: 'שיער|גבות|זקן|השתל|קרקפת|נשיר|FUE' },
];

const Q = (id, bot, text) => ({ id, bot, text, source: 'curated', status: 'open', raw_answer: null, knowledge_item_id: null, answered_at: null });
const QUESTIONS = [
  Q('iq_doc_01', 'doctors', 'אני אחות מוסמכת, לא רופאה — אפשר להירשם לקורס הזרקות?'),
  Q('iq_doc_02', 'doctors', 'הקורס כולל התנסות מעשית על מטופלים אמיתיים או רק תיאוריה?'),
  Q('iq_doc_03', 'doctors', 'כמה משתתפים יש בקבוצה, ויש ליווי אחרי הקורס?'),
  Q('iq_doc_04', 'doctors', 'מקבלים תעודה בסוף הקורס? היא מוכרת איפשהו?'),
  Q('iq_doc_05', 'doctors', 'אילו מסלולי המשך יש אחרי קורס הבסיס?'),
  Q('iq_doc_06', 'doctors', 'הקורסים מתקיימים גם בסופי שבוע או רק באמצע השבוע?'),
  Q('iq_doc_07', 'doctors', 'רופא שיניים יכול להשתתף בקורס הזרקות בוטוקס?'),
  Q('iq_doc_08', 'doctors', 'אפשר לשלם על הקורס בתשלומים?'),
  Q('iq_trt_01', 'treatments', 'בת כמה צריך להיות בשביל בוטוקס מניעתי?'),
  Q('iq_trt_02', 'treatments', 'כמה זמן מחזיק מילוי שפתיים, ומה קורה כשזה מתפוגג?'),
  Q('iq_trt_03', 'treatments', 'אפשר לעשות בוטוקס בהריון או בהנקה?'),
  Q('iq_trt_04', 'treatments', 'מה ההבדל בין פרופיילו לחומצה היאלורונית?'),
  Q('iq_trt_05', 'treatments', 'יש נפיחות אחרי הזרקות? תוך כמה זמן חוזרים לשגרה?'),
  Q('iq_trt_06', 'treatments', 'אתם מטפלים גם בגברים?'),
  Q('iq_trt_07', 'treatments', 'הפגישה הראשונה היא ייעוץ? היא בתשלום?'),
  Q('iq_trt_08', 'treatments', 'איך אני יודעת שהמזריק מוסמך ושבטוח לעשות את זה אצלכם?'),
  Q('iq_hair_01', 'hair', 'אחרי כמה זמן רואים תוצאות מהשתלת שיער?'),
  Q('iq_hair_02', 'hair', 'ההשתלה כואבת? כמה ימי החלמה צריך?'),
  Q('iq_hair_03', 'hair', 'אתם עושים גם השתלת זקן ושפם?'),
  Q('iq_hair_04', 'hair', 'אני אישה עם שיער דליל בקו הקדמי — השתלה מתאימה גם לנשים?'),
  Q('iq_hair_05', 'hair', 'מה ההבדל בין שיטת FUE לשיטות אחרות?'),
  Q('iq_hair_06', 'hair', 'השיער המושתל נושר אחרי תקופה? צריך טיפוח מיוחד?'),
  Q('iq_hair_07', 'hair', 'עשיתי השתלה במקום אחר ואני לא מרוצה — אפשר לתקן?'),
  Q('iq_hair_08', 'hair', 'כמה זקיקים צריך בערך לקו שיער קדמי?'),
];

async function createScratch() {
  const { data: biz, error } = await supabase.from('businesses')
    .insert({ name: 'Multibot E2E Scratch', slug: 'multibot-e2e-scratch-' + Date.now().toString(36), archetype: 'service', is_test: true })
    .select('id').single();
  if (error) throw error;
  const { error: pErr } = await supabase.from('business_profiles').insert({ business_id: biz.id });
  if (pErr) throw pErr;
  console.log('scratch business created:', biz.id);
  return biz.id;
}

async function main() {
  let bizId = process.argv[2];
  if (bizId === '--create-scratch') bizId = await createScratch();
  if (!bizId) { console.error('usage: seed-esthetic-multibot.mjs <business_id> | --create-scratch'); process.exit(1); }

  const { data, error } = await supabase.from('business_profiles')
    .select('draft_setup_data').eq('business_id', bizId).maybeSingle();
  if (error) throw error;
  if (!data) { console.error('no business_profiles row for', bizId); process.exit(1); }

  const draft = data.draft_setup_data ?? {};
  const existing = draft.interview?.questions ?? [];
  const have = new Set(existing.map(q => q.id));
  const merged = [...existing, ...QUESTIONS.filter(q => !have.has(q.id))];

  const { error: wErr } = await supabase.from('business_profiles').update({
    draft_setup_data: {
      ...draft,
      dashboard_config: { ...draft.dashboard_config, bots: BOTS },
      interview: { ...draft.interview, questions: merged },
    },
    updated_at: new Date().toISOString(),
  }).eq('business_id', bizId);
  if (wErr) throw wErr;

  console.log(`seeded ${bizId}: ${BOTS.length} bots, ${merged.length} interview questions (${merged.length - existing.length} new)`);
}

main().catch(e => { console.error(e); process.exit(1); });
