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
function seedOpen(rows, { supportsArrayColumn = true, platform = [] } = {}) {
  const state = [...rows];
  // The pass reads every tenant's WhatsApp line once (the bot-to-bot loop
  // breaker) and fails closed if it cannot, so the seam has to be installed
  // even for tests that have nothing to do with it — without it the real db
  // path is taken, supabase.js throws on the missing env, and every row is
  // skipped as unverified.
  relay._setDbForTest({
    async getBusiness() { return { whatsapp_number: null }; },
    async getSession() { return { qualification_progress: {} }; },
    async getLeadContact() { return null; },
    async listPlatformWhatsappNumbers() { return platform.map(n => ({ whatsapp_number: n })); },
  });
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

// ── I7: an unparseable timestamp defeated BOTH exits ─────────────────────────
// new Date('not-a-date').getTime() is NaN. `NaN >= maxAge` is false, so the
// age cap never fires; `NaN < interval` is false, so the interval gate never
// skips. The row was therefore nudged on EVERY pass, forever, and every nudge
// outside the 24h window is a billable business-initiated conversation. The
// age cap is documented as the backstop for every failure mode — it was not
// the backstop for this one.

test('an unparseable created_at expires the row instead of nudging it forever', async () => {
  const now = new Date('2026-07-26T09:00:00Z');
  const rows = seedOpen([{ id: 'e1', business_id: 'b1', status: 'open', short_code: 1,
    rep_phone: '972500000001', session_id: '9725000009', question: 'שאלה', nudge_count: 0,
    created_at: 'not-a-timestamp', last_nudge_at: null }]);
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'x' }] }; });

  const r = await relay.nudgePass({ now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4 });

  assert.equal(r.expired, 1, 'a row whose age cannot be computed must fail closed, not bill forever');
  assert.equal(rows[0].status, 'expired');
  assert.equal(sent.length, 0);
});

// The test above is also caught by the sibling last_nudge_at guard, because
// `last_nudge_at ?? created_at` falls back to the same bad value. Give the row
// a VALID last_nudge_at and only the created_at guard can save it — otherwise
// the age cap silently stops being the backstop it is documented to be.
test('an unparseable created_at is caught even when last_nudge_at is valid', async () => {
  const now = new Date('2026-07-26T09:00:00Z');
  const rows = seedOpen([{ id: 'e1', business_id: 'b1', status: 'open', short_code: 1,
    rep_phone: '972500000001', session_id: '9725000009', question: 'שאלה', nudge_count: 0,
    created_at: 'not-a-timestamp', last_nudge_at: new Date(now - 3 * HOUR).toISOString() }]);
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'x' }] }; });

  const r = await relay.nudgePass({ now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4 });

  assert.equal(r.expired, 1, 'an uncomputable age must fail closed even when the interval gate is satisfiable');
  assert.equal(rows[0].status, 'expired');
  assert.equal(sent.length, 0, 'a row whose age cannot be computed must never be billed');
});

test('an unparseable last_nudge_at expires the row instead of nudging it every pass', async () => {
  const now = new Date('2026-07-26T09:00:00Z');
  const rows = seedOpen([{ id: 'e1', business_id: 'b1', status: 'open', short_code: 1,
    rep_phone: '972500000001', session_id: '9725000009', question: 'שאלה', nudge_count: 0,
    created_at: new Date(now - 3 * HOUR).toISOString(), last_nudge_at: '0000-00-00' }]);
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'x' }] }; });

  const r = await relay.nudgePass({ now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4 });

  assert.equal(r.expired, 1);
  assert.equal(rows[0].status, 'expired');
  assert.equal(sent.length, 0, 'the interval gate cannot be trusted once the clock is unreadable');
});

// The same unbounded-billing shape without a bad timestamp: if recordNudge
// keeps failing, last_nudge_at never advances, so the interval gate passes on
// EVERY pass — a 5-minute scheduler would send ~860 nudges before the age cap.
// Charging the budget before attempting the send closes it: a failed charge
// means no send at all.

test('a persistently failing recordNudge sends nothing rather than re-nudging every pass', async () => {
  const now = new Date('2026-07-26T09:00:00Z');
  const state = [{ id: 'e1', business_id: 'b1', status: 'open', short_code: 1,
    rep_phone: '972500000001', session_id: '9725000009', question: 'שאלה', nudge_count: 0,
    created_at: new Date(now - 3 * HOUR).toISOString(),
    last_nudge_at: new Date(now - 3 * HOUR).toISOString() }];
  store._setDbForTest({
    async insert(r) { state.push(r); return r; },
    async listOpen(b) { return state.filter(r => r.business_id === b && r.status === 'open'); },
    async listAllOpen() { return state.filter(r => r.status === 'open'); },
    async update(id, patch) {
      if ('nudge_count' in patch) throw new Error('transient db error on the counter');
      Object.assign(state.find(r => r.id === id), patch);
    },
  });
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'x' }] }; });

  await relay.nudgePass({ now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4 });
  await relay.nudgePass({ now: new Date('2026-07-26T09:05:00Z'), isOpenNow: async () => true, intervalHours: 2, maxNudges: 4 });

  assert.equal(sent.length, 0,
    'if the nudge cannot be charged it must not be sent — otherwise every pass bills another template');
  assert.equal(state[0].nudge_count, 0);
});

// ── Age-cap clamp ────────────────────────────────────────────────────────────
// max(72, intervalHours * (maxNudges + 1)) has no upper bound. The admin UI
// clamps to 24h x 20 (~504h), but /business/update has no column whitelist and
// no auth unless STUDIO_AUTH_REQUIRED === 'true', so the derived value is not
// only reachable by the portal.

test('the derived age cap is clamped so an absurd cadence cannot keep a row open for weeks', async () => {
  const now = new Date('2026-07-26T09:00:00Z');
  const rows = seedOpen([{ id: 'e1', business_id: 'b1', status: 'open', short_code: 1,
    rep_phone: '972500000001', session_id: '9725000009', question: 'שאלה', nudge_count: 0,
    created_at: new Date(now - 200 * HOUR).toISOString(),
    last_nudge_at: new Date(now - 1 * HOUR).toISOString() }]);
  relay._setSenderForTest(async () => ({ messages: [{ id: 'x' }] }));

  const r = await relay.nudgePass({
    now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4,
    getNudgeSettings: async () => ({ nudge_interval_hours: 24, nudge_max_count: 20 }),
  });

  assert.equal(r.expired, 1, '24h x 21 = 504h must clamp to the 168h ceiling');
  assert.equal(rows[0].status, 'expired');
});

// The loop breaker applies to the SECOND hop too: a rep_phone captured before
// the guard existed (or after a whatsapp_number change) must not be nudged
// every two hours into another tenant's bot.

test('a nudge is never sent to another business\'s WhatsApp line', async () => {
  const now = new Date('2026-07-26T09:00:00Z');
  const rows = seedOpen([{ id: 'e1', business_id: 'b1', status: 'open', short_code: 1,
    rep_phone: '972559489893', session_id: '9725000009', question: 'שאלה', nudge_count: 0,
    created_at: new Date(now - 3 * HOUR).toISOString(),
    last_nudge_at: new Date(now - 3 * HOUR).toISOString() }]);
  relay._setDbForTest({
    async getBusiness() { return { whatsapp_number: null }; },
    async getSession() { return { qualification_progress: {} }; },
    async getLeadContact() { return null; },
    async listPlatformWhatsappNumbers() { return [{ whatsapp_number: '972559489893' }]; },
  });
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'x' }] }; });

  const r = await relay.nudgePass({ now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4 });

  assert.equal(sent.length, 0, 'nudging another tenant\'s bot line is the same loop, on a 2-hourly timer');
  assert.equal(r.nudged, 0);
  assert.equal(rows[0].nudge_count, 0, 'a destination we refuse to message must not burn the budget either');
});
