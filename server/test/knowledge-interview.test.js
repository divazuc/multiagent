import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'test-key-unused';
const ki = await import('../lib/knowledge-interview.js');

// In-memory stand-in for the two tables the module touches.
function fakeDb(draft) {
  const state = {
    draft: { draft_setup_data: draft },
    profileRow: { business_name: 'אסתטיק קליניק', persona: { bot_name: 'סאלי', bot_gender: 'female' }, guardrails: { forbidden_topics: ['מסירת מחירים בוואטסאפ'] } },
    inserted: [],
    updates: [],
  };
  ki._setDbForTest({
    async loadDraft() { return state.draft; },
    async saveDraft(_businessId, d) { state.updates.push(d); state.draft = { draft_setup_data: d }; },
    async loadProfile() { return state.profileRow; },
    async loadFaqQuestions() { return ['כמה זמן מראש צריך לקבוע תור?']; },
    async insertKnowledgeItem(row) { const r = { id: 'ki_' + state.inserted.length, ...row }; state.inserted.push(r); return r; },
  });
  return { state };
}

const OPEN_Q = { id: 'iq_1', bot: 'hair', text: 'ההשתלה כואבת?', source: 'curated', status: 'open', raw_answer: null, knowledge_item_id: null, answered_at: null };

test('getInterviewQuestions returns only open questions', async () => {
  fakeDb({ interview: { questions: [OPEN_Q, { ...OPEN_Q, id: 'iq_2', status: 'answered' }] } });
  const { questions } = await ki.getInterviewQuestions('b1');
  assert.deepEqual(questions.map(q => q.id), ['iq_1']);
});

test('answerInterviewQuestion: polish → suggested item → question marked answered', async () => {
  const db = fakeDb({ interview: { questions: [{ ...OPEN_Q }] } });
  ki._setClaudeForTest(async () => '```json\n{"question":"האם השתלת שיער כואבת?","answer":"התהליך בהרדמה מקומית ורוב המטופלים חוזרים לשגרה תוך יומיים.","category":"services"}\n```');
  const { item, question } = await ki.answerInterviewQuestion('b1', 'iq_1', 'זה לא כואב, הרדמה מקומית, יומיים מנוחה');
  assert.equal(item.suggested, true);
  assert.equal(item.is_active, false);
  assert.equal(item.category, 'services');
  assert.equal(question.status, 'answered');
  assert.equal(question.knowledge_item_id, item.id);
  const saved = db.state.draft.draft_setup_data.interview.questions[0];
  assert.equal(saved.status, 'answered');
  assert.equal(saved.raw_answer, 'זה לא כואב, הרדמה מקומית, יומיים מנוחה');
});

test('answerInterviewQuestion: failed polish keeps the question open with the raw answer saved', async () => {
  const db = fakeDb({ interview: { questions: [{ ...OPEN_Q }] } });
  ki._setClaudeForTest(async () => 'מצטער, איני יכול');
  await assert.rejects(() => ki.answerInterviewQuestion('b1', 'iq_1', 'תשובה גולמית'), /polish/);
  const saved = db.state.draft.draft_setup_data.interview.questions[0];
  assert.equal(saved.status, 'open');
  assert.equal(saved.raw_answer, 'תשובה גולמית');
  assert.equal(db.state.inserted.length, 0);
});

test('answerInterviewQuestion rejects an unknown or non-open question', async () => {
  fakeDb({ interview: { questions: [{ ...OPEN_Q, status: 'answered' }] } });
  await assert.rejects(() => ki.answerInterviewQuestion('b1', 'iq_1', 'x'), /not open/);
  await assert.rejects(() => ki.answerInterviewQuestion('b1', 'iq_missing', 'x'), /not open/);
});

test('dismissInterviewQuestion marks dismissed', async () => {
  const db = fakeDb({ interview: { questions: [{ ...OPEN_Q }] } });
  await ki.dismissInterviewQuestion('b1', 'iq_1');
  assert.equal(db.state.draft.draft_setup_data.interview.questions[0].status, 'dismissed');
});

test('generateInterviewQuestions appends deduped questions as generated', async () => {
  const db = fakeDb({ interview: { questions: [{ ...OPEN_Q }] } });
  ki._setClaudeForTest(async () => JSON.stringify({ questions: [
    'ההשתלה כואבת?',                       // dup of an existing interview question — dropped
    'כמה זמן מראש צריך לקבוע תור?',        // dup of an existing FAQ question — dropped
    'אפשר לעשות השתלת שיער בגיל 25?',      // new
  ] }));
  const { questions } = await ki.generateInterviewQuestions('b1', 'hair');
  assert.equal(questions.length, 1);
  assert.equal(questions[0].bot, 'hair');
  assert.equal(questions[0].source, 'generated');
  assert.equal(questions[0].status, 'open');
  assert.equal(db.state.draft.draft_setup_data.interview.questions.length, 2);
});

test('parseJsonResponse strips fences and rejects non-JSON', () => {
  assert.deepEqual(ki.parseJsonResponse('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(ki.parseJsonResponse('{"a":1}'), { a: 1 });
  assert.equal(ki.parseJsonResponse('לא JSON'), null);
});
