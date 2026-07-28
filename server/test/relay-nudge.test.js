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
