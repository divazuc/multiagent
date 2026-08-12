// Pilot finding #3 (2026-08-12, live): sessions must be per (phone, business).
// The owner's phone held ONE session row, bound to the Divaz business; her
// messages to the kids bot re-pointed that row (and its stage, qualification
// progress and history) back and forth between the two tenants. loadContext
// now scopes the session lookup to the business that owns the receiving
// number, creates a business-bound row on a miss, and — only on the
// pre-migration schema, where a second row cannot exist — falls back to
// today's single-row re-point.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://supabase.invalid';
process.env.SUPABASE_SERVICE_KEY = 'stub-service-key';

const { loadContext, _setSupabaseForTest } = await import('../lib/context.js');
const { fakeSupabase } = await import('./helpers/fake-supabase.js');

const KIDS = 'f53bdccc-kids';
const DIVAZ = '86efa161-divaz';
const PNID_KIDS = 'pnid-kids-333';
const PNID_DIVAZ = 'pnid-divaz-555';
const OWNER_PHONE = '972528250088';

const POST = [['session_id', 'business_id']];
const PRE = [['session_id']];

const profiles = [
  { business_id: KIDS, business_name: 'קרוספיט קידס', services: [], persona: {}, guardrails: {}, hebrew_patterns: {} },
  { business_id: DIVAZ, business_name: 'דיוה אוסט', services: [], persona: {}, guardrails: {}, hebrew_patterns: {} },
];

function seeded({ unique = POST, sessions = [], conversations = [], missingColumns = {} } = {}) {
  const fake = fakeSupabase({
    tables: {
      businesses: [
        { id: KIDS, wa_phone_number_id: PNID_KIDS },
        { id: DIVAZ, wa_phone_number_id: PNID_DIVAZ },
      ],
      business_profiles: JSON.parse(JSON.stringify(profiles)),
      sessions,
      conversations,
      setup_drafts: [],
    },
    uniques: { sessions: unique },
    missingColumns,
  });
  _setSupabaseForTest(fake);
  return fake;
}

const divazRow = (extra = {}) => ({
  session_id: OWNER_PHONE, business_id: DIVAZ, session_mode: 'live',
  current_stage: 'payment_pending', current_setup_stage: null, setup_completed: true,
  qualification_progress: { need: 'branding' }, updated_at: '2026-08-12T08:00:00Z', ...extra,
});

test.afterEach(() => _setSupabaseForTest(null));

// ── The exact owner scenario ─────────────────────────────────────────────────

test('active Divaz session + kids inbound → a NEW kids-bound session; the Divaz row is untouched', async () => {
  const fake = seeded({ sessions: [divazRow()] });
  const before = JSON.stringify(fake.tables.sessions[0]);

  const ctx = await loadContext({ message: 'הי', session_id: OWNER_PHONE, phone_number_id: PNID_KIDS });
  assert.equal(ctx.status, 'success');
  assert.equal(ctx.result.business_id, KIDS);
  assert.equal(ctx.result.current_stage, 'greeting', 'a fresh conversation, not the Divaz stage');
  assert.equal(ctx.result.business_profile.business_name, 'קרוספיט קידס');

  assert.equal(fake.tables.sessions.length, 2, 'a second, kids-bound row was created');
  const divaz = fake.tables.sessions.find(s => s.business_id === DIVAZ);
  assert.equal(JSON.stringify(divaz), before, 'the Divaz session must be byte-identical');
  const kids = fake.tables.sessions.find(s => s.business_id === KIDS);
  assert.equal(kids.session_mode, 'live');
});

test('and back: a Divaz inbound then reads the Divaz row, never the kids one', async () => {
  const kidsSession = {
    session_id: OWNER_PHONE, business_id: KIDS, session_mode: 'live',
    current_stage: 'greeting', current_setup_stage: null, setup_completed: true,
    qualification_progress: {}, updated_at: '2026-08-12T09:00:00Z',
  };
  const fake = seeded({ sessions: [divazRow(), kidsSession] });

  const ctx = await loadContext({ message: 'שלחתי צילום', session_id: OWNER_PHONE, phone_number_id: PNID_DIVAZ });
  assert.equal(ctx.status, 'success');
  assert.equal(ctx.result.business_id, DIVAZ);
  assert.equal(ctx.result.current_stage, 'payment_pending', 'the Divaz funnel state survives');
  assert.deepEqual(ctx.result.qualification_progress, { need: 'branding' });

  assert.equal(fake.tables.sessions.length, 2, 'no extra rows');
  const writes = fake.log.filter(op => op.table === 'sessions' && op.op !== 'select');
  assert.deepEqual(writes, [], 'a scoped hit performs zero session writes');
});

// ── Single-business phones: byte-identical to today ──────────────────────────

test('a single-business phone loads its session with zero session writes', async () => {
  const row = {
    session_id: '972501112223', business_id: KIDS, session_mode: 'live',
    current_stage: 'qualification', current_setup_stage: null, setup_completed: true,
    qualification_progress: {}, updated_at: '2026-08-11T10:00:00Z',
  };
  const fake = seeded({ unique: PRE, sessions: [row] });

  const ctx = await loadContext({ message: 'הי', session_id: '972501112223', phone_number_id: PNID_KIDS });
  assert.equal(ctx.status, 'success');
  assert.equal(ctx.result.business_id, KIDS);
  assert.equal(ctx.result.current_stage, 'qualification');
  const writes = fake.log.filter(op => op.table === 'sessions' && op.op !== 'select');
  assert.deepEqual(writes, []);
});

test('a brand-new phone gets a live greeting session bound to the receiving business', async () => {
  const fake = seeded({ unique: PRE, sessions: [] });
  const ctx = await loadContext({ message: 'הי', session_id: '972505556667', phone_number_id: PNID_KIDS });
  assert.equal(ctx.status, 'success');
  assert.equal(ctx.result.business_id, KIDS);
  assert.equal(ctx.result.current_stage, 'greeting');
  assert.equal(fake.tables.sessions.length, 1);
  assert.equal(fake.tables.sessions[0].business_id, KIDS);
  assert.equal(fake.tables.sessions[0].session_mode, 'live');
});

// ── Pre-migration schema: today's behaviour, exactly ─────────────────────────

test('pre-migration, a foreign-bound session is re-pointed at the receiving business (today\'s behaviour)', async () => {
  const fake = seeded({ unique: PRE, sessions: [divazRow()] });

  const ctx = await loadContext({ message: 'הי', session_id: OWNER_PHONE, phone_number_id: PNID_KIDS });
  assert.equal(ctx.status, 'success');
  assert.equal(ctx.result.business_id, KIDS);

  assert.equal(fake.tables.sessions.length, 1, 'the old schema cannot hold a second row');
  assert.equal(fake.tables.sessions[0].business_id, KIDS, 're-pointed, as today');
});

// ── Studio / no receiving number ─────────────────────────────────────────────

test('no phone_number_id: the session loads by id alone and keeps its business', async () => {
  const fake = seeded({
    sessions: [{
      session_id: 'studio-test-1', business_id: KIDS, session_mode: 'live',
      current_stage: 'greeting', current_setup_stage: null, setup_completed: true,
      qualification_progress: {}, updated_at: '2026-08-12T10:00:00Z',
    }],
  });
  const ctx = await loadContext({ message: 'הי', session_id: 'studio-test-1' });
  assert.equal(ctx.status, 'success');
  assert.equal(ctx.result.business_id, KIDS);
  const writes = fake.log.filter(op => op.table === 'sessions' && op.op !== 'select');
  assert.deepEqual(writes, []);
});

test('an unknown receiving number with an existing session keeps the session\'s business', async () => {
  seeded({ sessions: [divazRow()] });
  const ctx = await loadContext({ message: 'הי', session_id: OWNER_PHONE, phone_number_id: 'pnid-unknown' });
  assert.equal(ctx.status, 'success');
  assert.equal(ctx.result.business_id, DIVAZ);
});

test('an unknown number and no session still errors the same way as today', async () => {
  seeded({ sessions: [] });
  const ctx = await loadContext({ message: 'הי', session_id: '972500000001', phone_number_id: 'pnid-unknown' });
  assert.equal(ctx.status, 'error');
  assert.match(ctx.error, /No business found for phone_number_id: pnid-unknown/);
});

// ── History scoping ──────────────────────────────────────────────────────────

const historyRows = [
  { session_id: OWNER_PHONE, business_id: DIVAZ, role: 'user', content: 'כמה עולה מיתוג?', stage: 'discovery', created_at: '2026-08-10T10:00:00Z' },
  { session_id: OWNER_PHONE, business_id: DIVAZ, role: 'assistant', content: 'הצעת מחיר...', stage: 'discovery', created_at: '2026-08-10T10:00:05Z' },
  { session_id: OWNER_PHONE, business_id: KIDS, role: 'user', content: 'יש מקום לניסיון?', stage: 'greeting', created_at: '2026-08-12T09:00:00Z' },
];

test('history is scoped to the session\'s business — one tenant\'s thread never enters the other\'s context', async () => {
  const kidsSession = {
    session_id: OWNER_PHONE, business_id: KIDS, session_mode: 'live',
    current_stage: 'greeting', current_setup_stage: null, setup_completed: true,
    qualification_progress: {}, updated_at: '2026-08-12T09:00:00Z',
  };
  seeded({ sessions: [divazRow(), kidsSession], conversations: historyRows });

  const ctx = await loadContext({ message: 'הי', session_id: OWNER_PHONE, phone_number_id: PNID_KIDS });
  assert.equal(ctx.status, 'success');
  assert.deepEqual(ctx.result.conversation_history.map(m => m.content), ['יש מקום לניסיון?']);
});

test('on a pre-migration view (no business_id column) history falls back to today\'s unscoped read', async () => {
  seeded({
    unique: PRE,
    sessions: [divazRow()],
    conversations: historyRows,
    missingColumns: { conversations: ['business_id'] },
  });

  const ctx = await loadContext({ message: 'הי', session_id: OWNER_PHONE, phone_number_id: PNID_DIVAZ });
  assert.equal(ctx.status, 'success');
  assert.equal(ctx.result.conversation_history.length, 3, 'unscoped, exactly as today');
});

// ── Cross-tenant write guards elsewhere (source pins) ────────────────────────

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const serverRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(serverRoot, p), 'utf8').replace(/\r\n/g, '\n');

test('saveConversation advances only its own business\'s session row', () => {
  const src = read('lib/db.js');
  const update = src.indexOf("current_stage: stage,");
  assert.ok(update > -1, 'saveConversation session update found');
  const chain = src.slice(update, update + 700);
  assert.ok(chain.includes(".eq('business_id', business_id)"), 'must be business-scoped');
  assert.ok(chain.includes(".eq('session_mode', 'live')"));
});

test('no sessions write anywhere still relies on ON CONFLICT (session_id)', () => {
  // After the 2026-08-13 migration there is no unique index on session_id
  // alone, so any surviving upsert(..., { onConflict: 'session_id' }) against
  // sessions would 500 in production. Every call site was converted to
  // update-then-insert.
  for (const file of ['index.js', 'lib/db.js', 'lib/context.js', 'lib/studio.js', 'routes/data.js']) {
    const src = read(file);
    let at = src.indexOf(".from('sessions')");
    while (at !== -1) {
      // Inspect only THIS builder chain: stop at the next .from( call.
      const nextFrom = src.indexOf(".from('", at + 1);
      const window = src.slice(at, Math.min(at + 400, nextFrom === -1 ? at + 400 : nextFrom));
      assert.ok(!/\.upsert\(/.test(window),
        `${file}: sessions upsert at offset ${at} — must be update-then-insert`);
      at = src.indexOf(".from('sessions')", at + 1);
    }
  }
});
