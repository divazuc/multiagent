// server/test/relay-nudge.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../lib/relay/store.js';
import * as relay from '../lib/relay/index.js';

const HOUR = 3600 * 1000;

function seedOpen(rows) {
  const state = [...rows];
  store._setDbForTest({
    async insert(r) { state.push(r); return r; },
    async listOpen(b) { return state.filter(r => r.business_id === b && r.status === 'open'); },
    async listAllOpen() { return state.filter(r => r.status === 'open'); },
    async update(id, patch) { Object.assign(state.find(r => r.id === id), patch); },
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
