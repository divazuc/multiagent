// server/test/relay-nudge.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import * as contacts from '../lib/relay/contacts.js';
import * as store from '../lib/relay/store.js';
import * as relay from '../lib/relay/index.js';

const HOUR = 3600 * 1000;

// `supportsArrayColumn: false` models the escalations table BEFORE the
// rep_message_ids DDL is applied — postgres rejects the unknown column. The
// relay has to degrade to something correct in that state, because the branch
// can merge before an operator runs the migration.
function seedOpen(rows, { supportsArrayColumn = true } = {}) {
  const state = [...rows];
  store._setDbForTest({
    async insert(r) { state.push(r); return r; },
    // listOpen is contractually newest-first (see correlate.js) — the real
    // query orders by created_at desc.
    async listOpen(b) {
      return state.filter(r => r.business_id === b && r.status === 'open')
        .sort((a, x) => String(x.created_at ?? '').localeCompare(String(a.created_at ?? '')));
    },
    async listAllOpen() { return state.filter(r => r.status === 'open'); },
    async update(id, patch) {
      if (!supportsArrayColumn && 'rep_message_ids' in patch) {
        throw new Error(`column "rep_message_ids" of relation "escalations" does not exist`);
      }
      Object.assign(state.find(r => r.id === id), patch);
    },
  });
  return state;
}

test('an escalation past the interval is nudged inside working hours', async () => {
  const now = new Date('2026-07-26T09:00:00Z');
  const rows = seedOpen([{ id: 'e1', business_id: 'b1', status: 'open', short_code: 1,
    rep_phone: '972500000001', session_id: '9725000009', nudge_count: 0,
    last_nudge_at: new Date(now - 3 * HOUR).toISOString() }]);
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'x' }] }; });

  const r = await relay.nudgePass({ now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4 });

  assert.equal(r.nudged, 1);
  assert.equal(sent[0].to, '972500000001');
  assert.equal(rows[0].nudge_count, 1);
});

test('outside working hours nothing is sent and the counter is untouched', async () => {
  const now = new Date('2026-07-26T02:00:00Z');
  const rows = seedOpen([{ id: 'e1', business_id: 'b1', status: 'open', short_code: 1,
    rep_phone: '972500000001', session_id: '9725000009', nudge_count: 1,
    last_nudge_at: new Date(now - 5 * HOUR).toISOString() }]);
  relay._setSenderForTest(async () => { throw new Error('must not send at night'); });

  const r = await relay.nudgePass({ now, isOpenNow: async () => false, intervalHours: 2, maxNudges: 4 });

  assert.equal(r.nudged, 0);
  assert.equal(rows[0].nudge_count, 1, 'a quiet night must not consume the nudge budget');
});

test('an escalation inside the interval is left alone', async () => {
  const now = new Date('2026-07-26T09:00:00Z');
  seedOpen([{ id: 'e1', business_id: 'b1', status: 'open', short_code: 1,
    rep_phone: '972500000001', session_id: '9725000009', nudge_count: 0,
    last_nudge_at: new Date(now - 30 * 60 * 1000).toISOString() }]);
  relay._setSenderForTest(async () => { throw new Error('too soon'); });

  const r = await relay.nudgePass({ now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4 });
  assert.equal(r.nudged, 0);
});

test('at the ceiling the escalation expires and the lead is not messaged', async () => {
  const now = new Date('2026-07-26T09:00:00Z');
  const rows = seedOpen([{ id: 'e1', business_id: 'b1', status: 'open', short_code: 1,
    rep_phone: '972500000001', session_id: '9725000009', nudge_count: 4,
    last_nudge_at: new Date(now - 5 * HOUR).toISOString() }]);
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'x' }] }; });

  const r = await relay.nudgePass({ now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4 });

  assert.equal(r.expired, 1);
  assert.equal(rows[0].status, 'expired');
  assert.ok(!sent.some(m => m.to === '9725000009'), 'the lead is never messaged by the nudge pass');
});

test('an escalation never nudged yet uses created_at as the clock', async () => {
  const now = new Date('2026-07-26T09:00:00Z');
  seedOpen([{ id: 'e1', business_id: 'b1', status: 'open', short_code: 1,
    rep_phone: '972500000001', session_id: '9725000009', nudge_count: 0,
    last_nudge_at: null, created_at: new Date(now - 4 * HOUR).toISOString() }]);
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'x' }] }; });

  const r = await relay.nudgePass({ now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4 });
  assert.equal(r.nudged, 1);
});

// ── Per-business nudge cadence (review fix round 1) ──────────────────────────
// business_profiles.nudge_interval_hours / nudge_max_count are now live
// columns (migration applied to prod) and must actually govern the pass —
// a business configured for less frequent nudges must get fewer, not just a
// UI that claims it saved.

test("a business's own interval overrides the passed-in default", async () => {
  const now = new Date('2026-07-26T09:00:00Z');
  seedOpen([{ id: 'e1', business_id: 'b1', status: 'open', short_code: 1,
    rep_phone: '972500000001', session_id: '9725000009', nudge_count: 0,
    last_nudge_at: new Date(now - 3 * HOUR).toISOString() }]);
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'x' }] }; });

  const r = await relay.nudgePass({
    now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4,
    getNudgeSettings: async () => ({ nudge_interval_hours: 6, nudge_max_count: 4 }),
  });

  assert.equal(r.nudged, 0, "the business's 6h interval must win over the 2h default");
  assert.equal(sent.length, 0, 'a 3h gap must not even attempt a send when the business is configured for 6h');
});

test("a business's own ceiling expires an escalation the default would still be nudging", async () => {
  const now = new Date('2026-07-26T09:00:00Z');
  const rows = seedOpen([{ id: 'e1', business_id: 'b1', status: 'open', short_code: 1,
    rep_phone: '972500000001', session_id: '9725000009', nudge_count: 2,
    last_nudge_at: new Date(now - 5 * HOUR).toISOString() }]);
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'x' }] }; });

  const r = await relay.nudgePass({
    now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4,
    getNudgeSettings: async () => ({ nudge_interval_hours: 2, nudge_max_count: 2 }),
  });

  assert.equal(r.expired, 1, 'the configured ceiling of 2 must be honoured, not the default of 4');
  assert.equal(rows[0].status, 'expired');
  assert.equal(sent.length, 0, 'an expiring escalation must never message the rep');
});

test('a missing per-business setting (no row, or column not yet present) falls back to 2h / 4 nudges', async () => {
  const now = new Date('2026-07-26T09:00:00Z');
  seedOpen([{ id: 'e1', business_id: 'b1', status: 'open', short_code: 1,
    rep_phone: '972500000001', session_id: '9725000009', nudge_count: 0,
    last_nudge_at: new Date(now - 3 * HOUR).toISOString() }]);
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'x' }] }; });

  const r = await relay.nudgePass({
    now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4,
    getNudgeSettings: async () => null,
  });

  assert.equal(r.nudged, 1, 'no configured row must fall back to the 2h default, same as before this feature existed');
});

test('a getNudgeSettings failure for one business falls back to defaults instead of aborting the pass', async () => {
  const now = new Date('2026-07-26T09:00:00Z');
  const rows = seedOpen([{ id: 'e1', business_id: 'b1', status: 'open', short_code: 1,
    rep_phone: '972500000001', session_id: '9725000009', nudge_count: 0,
    last_nudge_at: new Date(now - 3 * HOUR).toISOString() }]);
  relay._setSenderForTest(async () => ({ messages: [{ id: 'x' }] }));

  const r = await relay.nudgePass({
    now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4,
    getNudgeSettings: async () => { throw new Error('transient db error'); },
  });

  assert.equal(r.nudged, 1);
  assert.equal(rows[0].nudge_count, 1);
});

test('getNudgeSettings is looked up once per business, not once per open escalation', async () => {
  const now = new Date('2026-07-26T09:00:00Z');
  seedOpen([
    { id: 'e1', business_id: 'b1', status: 'open', short_code: 1, rep_phone: '972500000001', session_id: 's1', nudge_count: 0, last_nudge_at: new Date(now - 3 * HOUR).toISOString() },
    { id: 'e2', business_id: 'b1', status: 'open', short_code: 2, rep_phone: '972500000001', session_id: 's2', nudge_count: 0, last_nudge_at: new Date(now - 3 * HOUR).toISOString() },
    { id: 'e3', business_id: 'b1', status: 'open', short_code: 3, rep_phone: '972500000001', session_id: 's3', nudge_count: 0, last_nudge_at: new Date(now - 3 * HOUR).toISOString() },
  ]);
  relay._setSenderForTest(async () => ({ messages: [{ id: 'x' }] }));
  let lookups = 0;

  const r = await relay.nudgePass({
    now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4,
    getNudgeSettings: async () => { lookups++; return { nudge_interval_hours: 2, nudge_max_count: 4 }; },
  });

  assert.equal(r.nudged, 3);
  assert.equal(lookups, 1, 'three open escalations for the same business must cost one settings lookup, not three');
});

// ── C3: a rep quote-replying to a NUDGE must reach the nudged escalation ─────
// raiseEscalation stores the original send's message id; nudgePass sent a
// second message and threw its id away. The nudge is by construction the most
// recent message in the rep's thread, so it is the one a rep naturally
// quote-replies to. Its context.id matched nothing, a natural answer carries no
// leading #N, and the ladder fell to matchedBy:'recent' — answering whichever
// escalation happened to be newest, i.e. the wrong lead.

const NUDGE_ROWS = () => ([
  { id: 'e1', business_id: 'b1', status: 'open', short_code: 1, question: 'שאלה של דנה',
    rep_phone: '972500000001', session_id: '972500000091', nudge_count: 0,
    rep_message_id: 'wamid.ORIG1', created_at: '2026-07-26T05:00:00Z',
    last_nudge_at: '2026-07-26T05:00:00Z' },
  { id: 'e2', business_id: 'b1', status: 'open', short_code: 2, question: 'שאלה של יעל',
    rep_phone: '972500000001', session_id: '972500000092', nudge_count: 0,
    rep_message_id: 'wamid.ORIG2', created_at: '2026-07-26T08:30:00Z',
    last_nudge_at: '2026-07-26T08:30:00Z' },
]);

function seedContactSide() {
  contacts._setDbForTest({
    async listContacts() { return [{ business_id: 'b1', role: 'rep', name: 'סאלי', phone: '972500000001' }]; },
    async upsertContact() {},
  });
  relay._setDbForTest({
    async getBusiness() { return { whatsapp_number: '972599999999' }; },
    async getSession() { return { qualification_progress: {} }; },
  });
  relay._setHistorySaverForTest(async () => ({ status: 'success', result: {}, error: null }));
  relay._setRewriterForTest(async (a) => a);
}

async function nudgeThenAnswer(state) {
  // 09:00 — only e1 (last nudged at 05:00) is past the 2h interval; e2 (08:30)
  // is not. So the nudge sitting in the rep's thread belongs to e1, while e2 is
  // the NEWEST open escalation and therefore what 'recent' would pick.
  const now = new Date('2026-07-26T09:00:00Z');
  relay._setSenderForTest(async () => ({ messages: [{ id: 'wamid.NUDGE1' }] }));
  const pass = await relay.nudgePass({ now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4 });
  assert.equal(pass.nudged, 1, 'exactly one escalation should have been nudged');

  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.ACK' }] }; });
  await relay.handleContactMessage({
    business: { id: 'b1', name: 'קליניקה' },
    from: '972500000001',
    text: 'כן, אפשר לפרוס עד 3 תשלומים',
    contextId: 'wamid.NUDGE1',
  });
  return { sent, state };
}

test('a rep quote-replying to a nudge answers the nudged lead, not the newest one', async () => {
  const state = seedOpen(NUDGE_ROWS());
  seedContactSide();

  const { sent } = await nudgeThenAnswer(state);

  assert.ok(sent.some(m => m.to === '972500000091'), 'דנה — the lead whose nudge the rep replied to — must get the answer');
  assert.ok(!sent.some(m => m.to === '972500000092'), 'יעל must NOT receive an answer to someone else\'s question');
  assert.equal(state.find(r => r.id === 'e1').status, 'answered');
  assert.equal(state.find(r => r.id === 'e2').status, 'open');
});

test('the original escalation message stays quote-matchable after a nudge', async () => {
  const state = seedOpen(NUDGE_ROWS());
  seedContactSide();
  const now = new Date('2026-07-26T09:00:00Z');
  relay._setSenderForTest(async () => ({ messages: [{ id: 'wamid.NUDGE1' }] }));
  await relay.nudgePass({ now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4 });

  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.ACK' }] }; });
  await relay.handleContactMessage({
    business: { id: 'b1', name: 'קליניקה' }, from: '972500000001',
    text: 'כן, אפשר', contextId: 'wamid.ORIG1',
  });

  assert.ok(sent.some(m => m.to === '972500000091'), 'a rep who scrolls up and quotes the ORIGINAL must still hit e1');
  assert.equal(state.find(r => r.id === 'e1').status, 'answered');
});

test('without the rep_message_ids column the nudge id still routes the reply correctly', async () => {
  const state = seedOpen(NUDGE_ROWS(), { supportsArrayColumn: false });
  seedContactSide();

  const { sent } = await nudgeThenAnswer(state);

  assert.ok(sent.some(m => m.to === '972500000091'),
    'pre-DDL the relay must fall back to repointing rep_message_id, never mis-deliver');
  assert.equal(state.find(r => r.id === 'e1').status, 'answered');
  assert.equal(state.find(r => r.id === 'e2').status, 'open');
});
