// Seed the FIRST external client tenant: "קרוספיט קידס — הדרקונים" — the kids
// program of CrossFit HaDrakonim — running via WhatsApp COEXISTENCE on the
// client's own number 054-8139333 (the owner keeps the WhatsApp Business app;
// the Cloud API is connected alongside it via Meta Embedded Signup).
//
//   node --env-file=.env.local scripts/seed-crossfit-kids-2026-08.mjs
//   node --env-file=.env.local scripts/seed-crossfit-kids-2026-08.mjs --dry-run
//
// --dry-run validates everything (env, KB row schema, uniqueness) and prints
// the plan WITHOUT touching the database — run it first, always.
//
// REQUIRED ENV (set after the Meta Embedded Signup onboarding):
//   CROSSFIT_KIDS_PHONE_NUMBER_ID   the Cloud API phone_number_id of 054-8139333
// OPTIONAL ENV:
//   CROSSFIT_KIDS_WA_ACCESS_TOKEN   per-business Graph token. Leave unset if the
//                                   number lives under the same system-user token
//                                   the platform already uses (businesses.wa_access_token
//                                   stays null and wa-send.js falls back to
//                                   WHATSAPP_ACCESS_TOKEN).
//
// The script ABORTS before touching anything if CROSSFIT_KIDS_PHONE_NUMBER_ID
// is unset — the tenant must not exist half-configured.
//
// PREREQUISITE: apply wa-studio/docs/sql/2026-08-12-coexistence.sql first
// (adds business_profiles.coexistence + coexistence_standdown_minutes and
// sessions.coexistence_standdown_until). The profile upsert below writes the
// coexistence columns and will fail loudly if the migration is missing.
//
// IDEMPOTENT, upsert semantics (same discipline as update-divaost-from-spec.mjs):
//   · businesses           — matched by slug; insert once, update in place after
//   · business_profiles    — upsert on business_id (persona/guardrails are the
//                            seed's to own; studio edits after go-live should be
//                            folded back into this file before any rerun)
//   · business_contacts    — owner row upsert on (business_id, role)
//   · business_modules     — trial_signup upsert on (business_id, module_key)
//   · knowledge_items      — INSERT ONLY with a rerun guard: a question that
//                            already exists is skipped, never overwritten, so a
//                            rerun can't clobber studio-side KB edits
//   · knowledge sync       — business_profiles.knowledge.faq_summary rebuilt
//                            from the ACTIVE items (mirrors POST /knowledge/sync)
//
// ── KB sources ──────────────────────────────────────────────────────────────
// Everything below is drafted from the live site content in landing_page_builder:
//   src/pages/projects/crossfit-kids-v2/content.ts     (program page)
//   src/pages/projects/crossfit-kids-trial/content.ts  (trial signup page)
//   src/pages/projects/crossfit-kids-terms/content.ts  (תקנון)
//   src/pages/projects/crossfit-hadrakonim/content.ts  (main gym: address)
// Rows whose facts could NOT be verified in that content are seeded with
// final=false (is_active=false, suggested=true → the dashboard approval strip)
// and marked [לאישור דיוה] in the comments here. NO prices and NO dates were
// invented anywhere.
//
// ── THE TRIAL-DATE ROW ──────────────────────────────────────────────────────
// The next-trial-date fact lives in ONE knowledge item (category
// 'אימון ניסיון', question 'מתי אימון הניסיון הקרוב?'). Update it whenever a
// new date opens — studio KB screen, or the client portal FAQ editor — and the
// bot picks it up on the next /knowledge/sync (the studio does that on save).
// It is seeded INACTIVE because the last published date (12/08/2026) has
// already passed at seed time.
import { supabase } from '../lib/supabase.js';

const SLUG = 'crossfit-kids-hadrakonim';
const NAME = 'קרוספיט קידס — הדרקונים';
const WHATSAPP_NUMBER = '972548139333';   // the coexistence number (054-8139333)
const OWNER_ESCALATION_PHONE = '972528250088'; // Diva — pilot phase
const OWNER_ESCALATION_NAME = 'דיוה (פיילוט)';

const PHONE_NUMBER_ID = process.env.CROSSFIT_KIDS_PHONE_NUMBER_ID?.trim();
const ACCESS_TOKEN = process.env.CROSSFIT_KIDS_WA_ACCESS_TOKEN?.trim() || null;

if (!PHONE_NUMBER_ID) {
  console.error(
    'ABORT: CROSSFIT_KIDS_PHONE_NUMBER_ID is not set.\n' +
    'This is the Cloud API phone_number_id of 054-8139333, issued by the Meta\n' +
    'Embedded Signup onboarding. Set it (e.g. in server/.env.local) and rerun:\n' +
    '  CROSSFIT_KIDS_PHONE_NUMBER_ID=<id> node --env-file=.env.local scripts/seed-crossfit-kids-2026-08.mjs');
  process.exit(1);
}

// ── Persona ──────────────────────────────────────────────────────────────────
// Feminine voice of the coach's studio. Warm and energetic but NOT childish —
// the audience is PARENTS of kids, not the kids. Short messages, KB facts
// only, graceful escalation on anything unknown.
const PERSONA = {
  bot_gender: 'female',
  tone: 'warm_energetic',
  answer_length: 'short',
  emoji_style: 'light',
  escalation_phrase: 'אני אבדוק עם המאמנת ונחזור אליכם 🙂',
  audience: 'הורים לילדים — לדבר אליהם כהורים, בגובה העיניים. חם ואנרגטי אבל לא ילדותי.',
  style_notes: 'הודעות קצרות. אמפתיה להתלבטויות של הורים (ילד ביישן, לא ספורטיבי). אימוג׳י במידה — 🐉💛 של המותג. לעולם לא להמציא מחירים, מועדים או הבטחות.',
};

const GUARDRAILS = {
  escalation_points: [
    'שאלה על מחיר החוג או מחיר אימון הניסיון',
    'ביטול הרשמה, החזר כספי או הקפאה',
    'נושא רפואי — פציעה, מגבלה בריאותית, התאמה רפואית',
    'תלונה או חוסר שביעות רצון',
    'בקשה מפורשת לדבר עם המאמנת',
    'שאלה שאין עליה תשובה במאגר הידע',
  ],
  forbidden_topics: [
    'נקיבת מחיר כלשהו — מחירי החוג אינם מפורסמים; תמיד להפנות למאמנת',
    'אישור סופי של מועד אימון ניסיון — רק המאמנת סוגרת מועד',
    'ייעוץ רפואי או התחייבות לגבי התאמה בריאותית',
    'הבטחת מקום בקבוצה — המקומות מוגבלים ורק המאמנת מאשרת',
  ],
  forbidden_custom:
    'אסור לנקוב במחיר, טווח מחירים או הנחה — לאף שירות. במקום זה: "אני אבדוק עם המאמנת ונחזור אליכם 🙂". ' +
    'אסור לאשר רישום או מועד סופי — הניסוח הוא תמיד "המאמנת תחזור אליכם לתיאום סופי". ' +
    'לענות רק מעובדות מאגר הידע — לעולם לא להמציא שעות, תאריכים, גילאים או תנאים.',
};

// ── Knowledge base ──────────────────────────────────────────────────────────
// R(category, question, answer, final) — final=false ⇒ is_active=false,
// suggested=true (approval strip), same convention as seed-divaost-faq.mjs.
const R = (c, q, a, final = true) => ({ c, q, a, final });
const KB_ITEMS = [
  // — What is CrossFit Kids (program page hero + statement)
  R('על החוג', 'מה זה קרוספיט קידס?',
    'CROSSFIT KIDS הוא חוג כושר חווייתי, מקצועי ומעצים לילדים מבית קרוספיט הדרקונים, המבוסס על אימוני קרוספיט מותאמי גיל. האימונים משלבים תנועה, כוח, קואורדינציה, זריזות, משחק, עבודת צוות ואתגרים מותאמים — באווירה חיובית, תומכת ומלאת אנרגיה.'),
  R('על החוג', 'מה הילדים מקבלים מהאימונים?',
    'בכל אימון הילדים לומדים לזוז טוב יותר, להכיר את הגוף שלהם, להתחזק, לשפר ביטחון עצמי וליהנות מתחושת הצלחה. האימונים בנויים בצורה הדרגתית, מגוונת ומהנה, כך שכל ילד וילדה מתקדמים בקצב שמתאים להם.'),
  R('על החוג', 'הילד שלי לא ספורטיבי במיוחד — זה מתאים לו?',
    'בדיוק בשבילו 💛 אצלנו אין ילדים "ספורטיביים" ו"לא ספורטיביים" — יש ילדים שעוד לא גילו כמה הם מסוגלים. אין תחרות ואין לחץ, רק סביבה חמה שבה כל ילד וילדה מתקדמים בקצב שלהם וצוברים ביטחון.'),
  R('על החוג', 'הילד שלי ביישן ולא מכיר אף אחד — מה עושים?',
    'זה טבעי לגמרי 💛 הרבה ילדים מגיעים ביישנים או בלי להכיר אף אחד, והמאמנות יודעות בדיוק איך לעטוף אותם. האווירה חמה ומכילה, ותוך כמה אימונים כבר יש חברים חדשים והמון ציפייה לפעם הבאה.'),

  // — Ages & groups & schedule (program page ageGroups)
  R('קבוצות ושעות', 'לאילו גילאים מיועד החוג ואיך מחולקות הקבוצות?',
    'מכיתה א׳ ומעלה, בשלוש קבוצות לפי גיל: כיתות א׳–ג׳ (גילאי 5–9), כיתות ד׳–ו׳ (גילאי 9–12) ונוער מכיתה ז׳. כך כל ילד וילדה מתאמנים עם בני גילם, בתכנים ובעצימות שמתאימים בדיוק להם.'),
  R('קבוצות ושעות', 'מה שעות האימונים של כל קבוצה?',
    'קבוצת כיתות א׳–ג׳: ימים ראשון ורביעי 16:45–17:30. קבוצת כיתות ד׳–ו׳: ימים ראשון ורביעי 16:00–16:45. קבוצת נוער (מכיתה ז׳): ימים שני וחמישי 16:00–16:45 או 16:45–17:30. שעות הפעילות מתפרסמות גם באפליקציית BOOSTAPP ועשויות להשתנות מעת לעת.'),
  R('קבוצות ושעות', 'כמה זמן נמשך אימון וכמה פעמים בשבוע?',
    'כל אימון נמשך 45 דקות של תנועה, משחק וכיף, פעמיים בשבוע.'),

  // — What happens in a session / trial (program page trainingFlow + trial page)
  R('אימון ניסיון', 'מה קורה באימון ניסיון?',
    'אימון הניסיון הוא התנסות אמיתית באימון של הקבוצה המתאימה לגיל, ללא התחייבות — לפני ההרשמה לחוג השנתי. אימון כולל חימום דינמי ומשחקי תנועה, תרגילי כוח מותאמים לילדים, עבודה על טכניקה נכונה ובטוחה, קפיצות וריצות וקואורדינציה, אתגרי צוות — וסיום אנרגטי וכיפי.'),
  R('אימון ניסיון', 'איך נרשמים לאימון ניסיון?',
    'אפשר להירשם ממש כאן בצ׳אט 🙂 צריך רק את שם ההורה, שם הילד/ה והגיל, ויום מועדף — ואני מעבירה למאמנת שתחזור אליכם לתיאום סופי. ההרשמה לאימון הניסיון מותנית באישור תקנון החוג וחתימה על הצהרת בריאות.'),
  R('אימון ניסיון', 'מה צריך להביא לאימון?',
    'כמעט כלום 🙂 בגדי ספורט נוחים, נעליים ובקבוק מים — ואת כל השאר תשאירו לנו.'),
  // [לאישור דיוה] — the last published trial date (12/08/2026 16:00, trial
  // page) has already passed at seed time. THIS is the easy-to-update row for
  // the next-trial-date fact: activate it with the new date via the studio KB
  // screen. Seeded INACTIVE so a stale date can never reach a parent.
  R('אימון ניסיון', 'מתי אימון הניסיון הקרוב?',
    'מועדי אימוני הניסיון נפתחים במהלך חודשי הקיץ. המועד הקרוב יעודכן כאן — בינתיים אשמח לרשום אתכם והמאמנת תחזור אליכם עם המועד המתאים 🙂', false),

  // — Location (program page + main gym page)
  R('מיקום', 'איפה מתקיימים האימונים?',
    'במועדון קרוספיט הדרקונים, רח׳ אילן רמון 5, נס ציונה.'),

  // — Coaches & safety (program page coaches + certification + faq)
  R('צוות ובטיחות', 'מי המאמנות?',
    'סאלי וונג — בעלים ומאמנת בקרוספיט הדרקונים, מוסמכת CrossFit Kids מטעם CrossFit העולמי ובעלת הכשרה לאימון קטינים מטעם מכון וינגייט. ודיוה אוסט — מאמנת בעלת הכשרה לאימון קטינים מטעם הג׳ימנסיה, עם גישה חיובית, סבלנית ומעצימה לילדים.'),
  R('צוות ובטיחות', 'האם האימונים בטוחים?',
    'אתם בידיים טובות 🙂 המאמנות מוסמכות לאימון קטינים, וכל אימון בנוי בקפידה — חימום, טכניקה נכונה ועומס שמתאים בדיוק לגיל. מלוות כל ילד וילדה מקרוב מהרגע שנכנסים ועד שיוצאים.'),
  R('צוות ובטיחות', 'האם ההורים יכולים להישאר בשיעור?',
    'ההורים לא נשארים בשיעור — ודווקא בשבילכם: אנחנו רוצות לבנות עם הילד/ה קשר וביטחון משלנו, ולתת חוויה שבה הוא מרוכז בעצמו ובאימון. אפשר להמתין בבר הקפה או לנצל את הזמן לאימון שלכם. אם ההיפרדות קשה — נמצא יחד פתרון עדין שמתאים לכם 💛'),

  // — Registration & terms (תקנון + program page)
  R('הרשמה ותנאים', 'איך נרשמים לחוג השנתי?',
    'משאירים פרטים כאן בצ׳אט או בטופס באתר, והמאמנת חוזרת אליכם עם כל המידע להרשמה. ההרשמה נעשית מול הורה/אפוטרופוס בלבד, וההצטרפות בכפוף למקום פנוי בקבוצה — מספר המקומות מוגבל עד 15 משתתפים בקבוצה, ולאחר מכן נפתחת רשימת המתנה.'),
  R('הרשמה ותנאים', 'מה קורה אחרי ההרשמה?',
    'מיד עם ההרשמה מקבלים גישה לאפליקציית BOOSTAPP — שם נמצאת מערכת השעות, הרשמה לשיעורים ועדכונים שוטפים.'),
  R('הרשמה ותנאים', 'מה מדיניות הביטול של החוג?',
    'ביטול השתתפות בחוג נעשה בהודעה בכתב להנהלת המועדון עד 30 יום מראש, לפני מועד החיוב הבא. בנוסף, לפי חוק הגנת הצרכן אפשר לבטל בתוך 14 יום ממועד ההרשמה בניכוי דמי ביטול של 5% או 100 ₪, לפי הנמוך. לפרטים מלאים — תקנון החוג.'),
  R('הרשמה ותנאים', 'הילד היה חולה ופספס שיעור — יש השלמה?',
    'לא ניתן לקבל השלמה או החזר על שיעורים שלא נוצלו, מכל סיבה שהיא, אלא אם נקבע אחרת בתנאי המסלול. חשוב גם לא להביא ילדים לחוג כשהם חולים או עם חום.'),
  R('הרשמה ותנאים', 'מה קורה אם מאחרים לאימון?',
    'מטעמי בטיחות, איחור של 10 דקות מתחילת האימון לא יאפשר כניסה לשיעור — החימום הוא חלק חשוב מהאימון.'),
  R('הרשמה ותנאים', 'האם צריך הצהרת בריאות?',
    'כן — ההרשמה (גם לאימון ניסיון) כוללת הצהרת הורה על בריאות הילד/ה וכשירות לפעילות גופנית. חשוב לעדכן את המאמנות על כל שינוי במצב הבריאותי.'),
  R('הרשמה ותנאים', 'האם מצלמים את הילדים במהלך הפעילות?',
    'התקנון כולל הסכמת הורים לצילום ולשימוש בחומרים לצורכי שיווק המועדון ברשתות החברתיות. הורה שמעוניין שלא לאשר צילום ופרסום של ילדו — מעדכן את הנהלת המועדון מראש ובכתב, ופועלים בהתאם.'),
  R('הרשמה ותנאים', 'החוג בתשלום נפרד מהמנוי של ההורים?',
    'כן — חוג הילדים הוא בתשלום נפרד ממנוי המבוגרים. לגבי מחירים ומסלולים — אני אבדוק עם המאמנת ונחזור אליכם 🙂'),

  // ── [לאישור דיוה] — facts NOT found in the site content ──────────────────
  // Seeded inactive (approval strip). No numbers were invented.
  // [לאישור דיוה] annual program price — not published anywhere.
  R('מחירים', 'כמה עולה החוג?',
    'את המחירים והמסלולים המאמנת מוסרת אישית — אני מעבירה לה את הפרטים שלכם והיא חוזרת אליכם עם כל המידע 🙂', false),
  // [לאישור דיוה] trial price — the trial page never says it is free.
  R('מחירים', 'כמה עולה אימון הניסיון?',
    'לגבי עלות אימון הניסיון — אני אבדוק עם המאמנת ונחזור אליכם 🙂', false),
  // [לאישור דיוה] season start date — not in the content.
  R('על החוג', 'מתי מתחילה שנת הפעילות של החוג?',
    'ההרשמה לחוג השנתי בעיצומה, ואימוני ניסיון מתקיימים במהלך חודשי הקיץ. לגבי מועד פתיחת השנה המדויק — אני אבדוק עם המאמנת ונחזור אליכם 🙂', false),
  // [לאישור דיוה] age-range conflict: program page says "מכיתה א׳ ומעלה",
  // the תקנון says "מגיל 3 עד 18". Which is it for actual enrollment?
  R('קבוצות ושעות', 'יש קבוצה לילדים לפני כיתה א׳ (גן)?',
    'הקבוצות המפורסמות הן מכיתה א׳ ומעלה. לגבי פתרון לילדי גן — אני אבדוק עם המאמנת ונחזור אליכם 🙂', false),
];

// ── Validation (runs in every mode, before any write) ───────────────────────
function validateKb() {
  const problems = [];
  const seen = new Set();
  for (const [i, item] of KB_ITEMS.entries()) {
    for (const key of ['c', 'q', 'a']) {
      if (typeof item[key] !== 'string' || !item[key].trim()) problems.push(`row ${i}: empty ${key}`);
    }
    if (typeof item.final !== 'boolean') problems.push(`row ${i}: final must be boolean`);
    if (seen.has(item.q)) problems.push(`row ${i}: duplicate question "${item.q}"`);
    seen.add(item.q);
  }
  if (problems.length) throw new Error(`KB validation failed:\n  ${problems.join('\n  ')}`);
  return {
    total: KB_ITEMS.length,
    active: KB_ITEMS.filter(i => i.final).length,
    pending: KB_ITEMS.filter(i => !i.final).length,
  };
}

// ── Seed ─────────────────────────────────────────────────────────────────────

async function upsertBusiness() {
  const { data: existing, error: selErr } = await supabase.from('businesses')
    .select('id').eq('slug', SLUG).maybeSingle();
  if (selErr) throw selErr;

  const fields = {
    name: NAME,
    archetype: 'studio',
    status: 'active',
    is_test: false,
    whatsapp_number: WHATSAPP_NUMBER,
    wa_phone_number_id: PHONE_NUMBER_ID,
    // Only set when provided — a rerun without the env var must not blank a
    // token that was set after Meta onboarding.
    ...(ACCESS_TOKEN ? { wa_access_token: ACCESS_TOKEN } : {}),
  };

  if (existing) {
    const { error } = await supabase.from('businesses')
      .update({ ...fields, updated_at: new Date().toISOString() }).eq('id', existing.id);
    if (error) throw error;
    console.log(`businesses: updated ${existing.id}`);
    return existing.id;
  }
  const { data, error } = await supabase.from('businesses')
    .insert({ slug: SLUG, ...fields }).select('id').single();
  if (error) throw error;
  console.log(`businesses: created ${data.id}`);
  return data.id;
}

async function upsertProfile(bizId) {
  const { error } = await supabase.from('business_profiles').upsert({
    business_id: bizId,
    business_name: NAME,
    business_model: 'studio',
    agent_mode: 'hybrid',            // answer parents' questions + soft CTA to the trial
    cta_goal: 'trial_signup',
    persona: PERSONA,
    guardrails: GUARDRAILS,
    hebrew_patterns: {},
    agent_active: true,
    answer_after_hours: true,        // parents write in the evening — the bot answers
    new_contacts_only: false,
    skip_initiated_conversations: false, // COEXISTENCE: the owner opens threads from
                                         // the app; a customer replying there must
                                         // still reach the bot once standdown expires
    followup_enabled: false,
    // Coexistence — the whole point of this tenant (requires the
    // 2026-08-12-coexistence.sql migration):
    coexistence: true,
    coexistence_standdown_minutes: 720, // 12h owner standdown
    setup_completed: true,
    committed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'business_id' });
  if (error) throw error;
  console.log('business_profiles: upserted (coexistence=true, standdown=720m)');
}

async function upsertOwnerContact(bizId) {
  const { error } = await supabase.from('business_contacts').upsert({
    business_id: bizId, role: 'owner',
    name: OWNER_ESCALATION_NAME, phone: OWNER_ESCALATION_PHONE,
    notes: 'פיילוט: אסקלציות וסיכומי רישום לאימון ניסיון מגיעים לדיוה, לא ללקוחה',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'business_id,role' });
  if (error) throw error;
  console.log(`business_contacts: owner escalation → ${OWNER_ESCALATION_PHONE}`);
}

async function upsertTrialModule(bizId) {
  const { error } = await supabase.from('business_modules').upsert({
    business_id: bizId, module_key: 'trial_signup',
    enabled: true, settings: {}, status: 'connected',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'business_id,module_key' });
  if (error) throw error;
  console.log('business_modules: trial_signup enabled');
}

async function insertKb(bizId) {
  // Rerun guard — INSERT ONLY, existing questions are never overwritten.
  const { data: existing, error } = await supabase.from('knowledge_items')
    .select('question').eq('business_id', bizId);
  if (error) throw error;
  const have = new Set((existing ?? []).map(r => r.question));
  const fresh = KB_ITEMS.filter(i => !have.has(i.q)).map(i => ({
    business_id: bizId, category: i.c, question: i.q, answer: i.a,
    language: 'he', archetypes: [], is_active: i.final, suggested: !i.final,
  }));
  if (fresh.length) {
    const { error: insErr } = await supabase.from('knowledge_items').insert(fresh);
    if (insErr) throw insErr;
  }
  const active = fresh.filter(r => r.is_active).length;
  console.log(`knowledge_items: inserted ${fresh.length} (${active} active, ${fresh.length - active} pending approval; ${KB_ITEMS.length - fresh.length} already existed)`);
}

// Mirrors POST /knowledge/sync (server/index.js) so the conversation agent's
// business_profile.knowledge is populated on day one without a manual studio
// visit. Safe on rerun — rebuilt from whatever is active NOW.
async function syncKnowledge(bizId) {
  const { data: items, error } = await supabase.from('knowledge_items')
    .select('question, answer, category')
    .eq('business_id', bizId).eq('is_active', true).order('category');
  if (error) throw error;
  if (!items?.length) { console.log('knowledge sync: nothing active'); return; }
  const grouped = items.reduce((acc, item) => {
    if (!acc[item.category]) acc[item.category] = [];
    if (item.answer) acc[item.category].push(`Q: ${item.question}\nA: ${item.answer}`);
    return acc;
  }, {});
  const faq_summary = Object.entries(grouped)
    .map(([cat, qs]) => `[${cat}]\n${qs.join('\n\n')}`).join('\n\n---\n\n');
  const { error: wErr } = await supabase.from('business_profiles')
    .update({ knowledge: { faq_summary, synced_at: new Date().toISOString() }, updated_at: new Date().toISOString() })
    .eq('business_id', bizId);
  if (wErr) throw wErr;
  console.log(`knowledge sync: ${items.length} active items → business_profiles.knowledge`);
}

async function main() {
  const kb = validateKb();

  if (process.argv.includes('--dry-run')) {
    console.log('DRY RUN — nothing will be written. Plan:');
    console.log(`  businesses:        upsert slug=${SLUG} name="${NAME}" wa_phone_number_id=${PHONE_NUMBER_ID} whatsapp_number=${WHATSAPP_NUMBER}${ACCESS_TOKEN ? ' (+wa_access_token)' : ''}`);
    console.log('  business_profiles: upsert coexistence=true, coexistence_standdown_minutes=720, agent_mode=hybrid');
    console.log(`  business_contacts: owner escalation → ${OWNER_ESCALATION_PHONE} (${OWNER_ESCALATION_NAME})`);
    console.log('  business_modules:  trial_signup enabled');
    console.log(`  knowledge_items:   ${kb.total} rows (${kb.active} active, ${kb.pending} pending [לאישור דיוה]); insert-only, existing questions skipped`);
    console.log('  destructive ops:   none (no deletes, KB never overwritten on rerun)');
    console.log('DRY RUN OK');
    return;
  }

  const bizId = await upsertBusiness();
  await upsertProfile(bizId);
  await upsertOwnerContact(bizId);
  await upsertTrialModule(bizId);
  await insertKb(bizId);
  await syncKnowledge(bizId);
  console.log(`\nDONE — business ${bizId} ("${NAME}")`);
  console.log(`phone_number_id ${PHONE_NUMBER_ID} → this business (inbound routing is live as soon as the Meta webhook subscribes this number).`);
  console.log('Reminders: apply 2026-08-12-coexistence.sql (if not yet), subscribe the message_echoes webhook field, and approve the [לאישור דיוה] KB rows in the dashboard.');
}

main().catch(e => { console.error(e); process.exit(1); });
