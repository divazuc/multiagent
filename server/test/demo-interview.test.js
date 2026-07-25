import test from 'node:test';
import assert from 'node:assert/strict';

// demo.js constructs the Anthropic client at module scope; the key is never
// used because every test injects its own extractor.
process.env.ANTHROPIC_API_KEY = 'test-key-unused';
const demo = await import('../agents/demo.js');

const ALL_KEYS = demo.DEMO_QUESTIONS.map(q => q.key);

function answersFor(keys) {
  return Object.fromEntries(keys.map(k => [k, `תשובה ל-${k}`]));
}

// Minimal stand-in for the persistence demo.js needs, mirroring the
// _setDbForTest seam used by lib/modules/engine.js.
function fakeDb(draft, opts = {}) {
  const state = {
    draft: draft === null ? null : { draft_setup_data: draft, current_setup_stage: null },
    persona: opts.persona ?? {},
    sessionLive: false,
    savedDrafts: [],
    savedPersonas: [],
  };
  return {
    state,
    async loadDraft() { return state.draft; },
    async saveDraft(row) {
      state.savedDrafts.push(row);
      state.draft = { draft_setup_data: row.draft_setup_data, current_setup_stage: row.current_setup_stage ?? null };
    },
    async loadPersona() { return state.persona; },
    async savePersona(_businessId, persona) { state.savedPersonas.push(persona); state.persona = persona; },
    async setSessionLive() { state.sessionLive = true; },
  };
}

const CTX = { business_id: 'b1' };

test('parseVoiceResponse strips the markdown fence the model wraps JSON in', () => {
  const raw = '```json\n{"tone":["warm"],"voice_summary":"קול חם וישיר"}\n```';
  const v = demo.parseVoiceResponse(raw);
  assert.deepEqual(v.tone, ['warm']);
  assert.equal(v.voice_summary, 'קול חם וישיר');
});

test('parseVoiceResponse parses bare JSON with no fence', () => {
  const v = demo.parseVoiceResponse('{"emoji_style":"light"}');
  assert.equal(v.emoji_style, 'light');
});

test('parseVoiceResponse returns null when there is no JSON at all', () => {
  assert.equal(demo.parseVoiceResponse('מצטער, לא הצלחתי'), null);
});

test('a message arriving after a completed interview does not re-run extraction', async () => {
  let extractions = 0;
  demo._setExtractorForTest(async () => { extractions++; return { voice_summary: 'נוצר שוב' }; });
  const db = fakeDb({
    demo_answers: answersFor(ALL_KEYS),
    voice_extracted: true,
    voice_profile: { voice_summary: 'הקול המקורי' },
  });
  demo._setDbForTest(db);

  const r = await demo.runDemo({ message: 'תודה רבה!', session_id: 's1', context: CTX });

  assert.equal(extractions, 0, 'extraction must not run again once the interview is complete');
  assert.equal(r.result.is_done, true);
  assert.equal(r.result.voice_profile.voice_summary, 'הקול המקורי');
  assert.equal(db.state.savedPersonas.length, 0, 'a completed interview must not overwrite the persona');
});

test('the final answer runs extraction once and records the completion guard', async () => {
  let extractions = 0;
  demo._setExtractorForTest(async () => { extractions++; return { voice_summary: 'קול חם', tone: ['warm'] }; });
  const db = fakeDb({ demo_answers: answersFor(ALL_KEYS.slice(0, -1)) });
  demo._setDbForTest(db);

  const r = await demo.runDemo({ message: 'התשובה האחרונה', session_id: 's1', context: CTX });

  assert.equal(extractions, 1);
  assert.equal(r.result.is_done, true);
  assert.equal(db.state.savedPersonas.length, 1);
  assert.equal(db.state.draft.draft_setup_data.voice_extracted, true, 'guard must be persisted');
  assert.equal(db.state.sessionLive, true);
});

test('a failed extraction does not tell the owner the agent is ready', async () => {
  demo._setExtractorForTest(async () => null);
  const db = fakeDb({ demo_answers: answersFor(ALL_KEYS.slice(0, -1)) });
  demo._setDbForTest(db);

  const r = await demo.runDemo({ message: 'התשובה האחרונה', session_id: 's1', context: CTX });

  assert.equal(r.result.is_done, false, 'a failed extraction must not close the interview');
  assert.ok(!r.result.response.includes('הסוכן מוכן'), 'must not claim success');
  assert.equal(db.state.savedPersonas.length, 0);
  assert.equal(db.state.sessionLive, false, 'session must not go live on a failed extraction');
  assert.notEqual(db.state.draft.draft_setup_data.voice_extracted, true, 'guard must not be set on failure');
});

test('a failed extraction can be retried by sending another message', async () => {
  let extractions = 0;
  demo._setExtractorForTest(async () => (++extractions === 1 ? null : { voice_summary: 'הצליח בניסיון השני' }));
  const db = fakeDb({ demo_answers: answersFor(ALL_KEYS.slice(0, -1)) });
  demo._setDbForTest(db);

  const first = await demo.runDemo({ message: 'התשובה האחרונה', session_id: 's1', context: CTX });
  assert.equal(first.result.is_done, false);

  const second = await demo.runDemo({ message: 'ננסה שוב', session_id: 's1', context: CTX });

  assert.equal(extractions, 2);
  assert.equal(second.result.is_done, true);
  assert.equal(second.result.voice_profile.voice_summary, 'הצליח בניסיון השני');
});

test('a mid-interview answer is stored and the next question is returned', async () => {
  demo._setExtractorForTest(async () => { throw new Error('must not extract mid-interview'); });
  const db = fakeDb({ demo_answers: {} });
  demo._setDbForTest(db);

  const r = await demo.runDemo({ message: 'העסק שלי עושה אתרים', session_id: 's1', context: CTX });

  assert.equal(r.result.is_done, false);
  assert.equal(r.result.next_question_index, 2, 'first answer stored, second question served');
  assert.equal(db.state.draft.draft_setup_data.demo_answers[ALL_KEYS[0]], 'העסק שלי עושה אתרים');
});
