// The ongoing knowledge-enrichment interview: curated/generated questions live
// in business_profiles.draft_setup_data.interview; a free-language owner
// answer is polished by Claude into a suggested knowledge_item that lands in
// the FAQ tab's existing approval strip. Read-merge-write on the JSONB is
// acceptable here: a single owner edits their own dashboard.

const CATEGORIES = ['general', 'services', 'pricing', 'booking', 'scheduling', 'location', 'safety', 'trial'];
const MODEL = 'claude-sonnet-4-6';

let _claude = null;   // test seam: async (prompt, maxTokens) => text
let _db = null;       // test seam: {loadDraft, saveDraft, loadProfile, loadFaqQuestions, insertKnowledgeItem}
export function _setClaudeForTest(fn) { _claude = fn; }
export function _setDbForTest(db) { _db = db; }

async function db() {
  if (_db) return _db;
  const { supabase } = await import('./supabase.js');
  return {
    async loadDraft(businessId) {
      const { data, error } = await supabase.from('business_profiles')
        .select('draft_setup_data').eq('business_id', businessId).maybeSingle();
      if (error) throw error;
      return data;
    },
    async saveDraft(businessId, draft) {
      const { error } = await supabase.from('business_profiles')
        .update({ draft_setup_data: draft, updated_at: new Date().toISOString() })
        .eq('business_id', businessId);
      if (error) throw error;
    },
    async loadProfile(businessId) {
      const [{ data: prof }, { data: biz }] = await Promise.all([
        supabase.from('business_profiles').select('persona, guardrails').eq('business_id', businessId).maybeSingle(),
        supabase.from('businesses').select('name').eq('id', businessId).maybeSingle(),
      ]);
      return { business_name: biz?.name ?? '', persona: prof?.persona ?? {}, guardrails: prof?.guardrails ?? {} };
    },
    async loadFaqQuestions(businessId) {
      const { data } = await supabase.from('knowledge_items')
        .select('question').eq('business_id', businessId);
      return (data ?? []).map(r => r.question);
    },
    async insertKnowledgeItem(row) {
      const { data, error } = await supabase.from('knowledge_items').insert(row).select().maybeSingle();
      if (error) throw error;
      return data;
    },
  };
}

async function callClaude(prompt, maxTokens = 700) {
  if (_claude) return _claude(prompt, maxTokens);
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: MODEL, max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.content[0]?.text ?? '';
}

export function parseJsonResponse(raw) {
  if (!raw) return null;
  const m = String(raw).match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function loadInterviewState(businessId) {
  const d = await db();
  const row = await d.loadDraft(businessId);
  if (!row) { const e = new Error('business profile not found'); e.status = 404; throw e; }
  const draft = row.draft_setup_data ?? {};
  return { d, draft, questions: draft.interview?.questions ?? [] };
}

async function saveQuestions(d, businessId, draft, questions) {
  await d.saveDraft(businessId, { ...draft, interview: { ...draft.interview, questions } });
}

export async function getInterviewQuestions(businessId) {
  const { questions } = await loadInterviewState(businessId);
  return { questions: questions.filter(q => q.status === 'open') };
}

export async function dismissInterviewQuestion(businessId, questionId) {
  const { d, draft, questions } = await loadInterviewState(businessId);
  const next = questions.map(q => q.id === questionId ? { ...q, status: 'dismissed' } : q);
  await saveQuestions(d, businessId, draft, next);
  return { ok: true };
}

const norm = (s) => String(s ?? '').replace(/[?״"׳'.,!]/g, '').replace(/\s+/g, ' ').trim();

export async function answerInterviewQuestion(businessId, questionId, rawAnswer) {
  if (!rawAnswer?.trim()) { const e = new Error('rawAnswer is required'); e.status = 400; throw e; }
  const { d, draft, questions } = await loadInterviewState(businessId);
  const q = questions.find(x => x.id === questionId && x.status === 'open');
  if (!q) { const e = new Error('question not open'); e.status = 404; throw e; }

  // Persist the raw answer BEFORE the model call — it must survive a failed polish.
  let next = questions.map(x => x.id === questionId ? { ...x, raw_answer: rawAnswer } : x);
  await saveQuestions(d, businessId, draft, next);

  const profile = await d.loadProfile(businessId);
  const guardLines = [
    ...(profile.guardrails.forbidden_topics ?? []),
    profile.guardrails.forbidden_custom,
  ].filter(Boolean).map(t => `- ${t}`).join('\n');

  const prompt = `אתה עוזר לבעל עסק להפוך תשובה גולמית לפריט שאלות-ותשובות מלוטש עבור סוכן וואטסאפ.

העסק: ${profile.business_name}
${profile.persona.bot_name ? `שם הבוט: ${profile.persona.bot_name} (לשון ${profile.persona.bot_gender === 'male' ? 'זכר' : 'נקבה'})` : ''}
${guardLines ? `נושאים שהבוט לעולם אינו עונה עליהם ישירות (אם התשובה נוגעת בהם — נסח הפניה לנציגה במקום פירוט):\n${guardLines}` : ''}

השאלה כפי שלקוחות שואלים אותה: ${q.text}
התשובה הגולמית של בעל העסק (בשפתו החופשית): ${rawAnswer}

נסח מחדש: שאלה קצרה וטבעית (קרובה למקור) ותשובה חמה ומקצועית בקול המותג, 2–4 משפטים, בלי להמציא עובדות שאינן בתשובת הבעלים. בחר category מתוך: ${CATEGORIES.join(', ')}.

החזר JSON בלבד: {"question": "...", "answer": "...", "category": "..."}`;

  const parsed = parseJsonResponse(await callClaude(prompt, 700));
  if (!parsed?.question || !parsed?.answer) {
    const e = new Error('polish failed — raw answer saved, try again'); e.status = 502; throw e;
  }

  const item = await d.insertKnowledgeItem({
    business_id: businessId,
    category: CATEGORIES.includes(parsed.category) ? parsed.category : 'general',
    question: parsed.question,
    answer: parsed.answer,
    is_active: false,
    suggested: true,
    language: 'he',
  });

  next = next.map(x => x.id === questionId
    ? { ...x, status: 'answered', knowledge_item_id: item.id, answered_at: new Date().toISOString() }
    : x);
  await saveQuestions(d, businessId, draft, next);
  return { item, question: next.find(x => x.id === questionId) };
}

export async function generateInterviewQuestions(businessId, bot = null) {
  const { d, draft, questions } = await loadInterviewState(businessId);
  const profile = await d.loadProfile(businessId);
  const faq = await d.loadFaqQuestions(businessId);
  const known = new Set([...questions.map(q => norm(q.text)), ...faq.map(norm)]);

  const botMeta = (draft.dashboard_config?.bots ?? []).find(b => b.id === bot);
  const prompt = `אתה אוסף שאלות אמיתיות שלקוחות שואלים ברשת (פורומים, קבוצות, גוגל) על עסקים כמו זה:

העסק: ${profile.business_name}
${botMeta ? `התחום המבוקש: ${botMeta.name}` : 'כל תחומי העסק'}

שאלות שכבר קיימות במאגר (אל תחזור עליהן או על ניסוח דומה):
${[...questions.map(q => q.text), ...faq].map(t => `- ${t}`).join('\n')}

כתוב 3–5 שאלות חדשות, מנוסחות בדיוק כמו שלקוח אמיתי כותב (טבעי, לא פורמלי).
החזר JSON בלבד: {"questions": ["...", "..."]}`;

  const parsed = parseJsonResponse(await callClaude(prompt, 600));
  const texts = Array.isArray(parsed?.questions) ? parsed.questions : [];
  const fresh = texts
    .map(t => String(t).trim()).filter(Boolean)
    .filter(t => !known.has(norm(t)))
    .map((t, i) => ({
      id: `iq_gen_${Date.now().toString(36)}_${i}`,
      bot: bot ?? botMeta?.id ?? null,
      text: t, source: 'generated', status: 'open',
      raw_answer: null, knowledge_item_id: null, answered_at: null,
    }));
  if (fresh.length) await saveQuestions(d, businessId, draft, [...questions, ...fresh]);
  return { questions: fresh };
}
