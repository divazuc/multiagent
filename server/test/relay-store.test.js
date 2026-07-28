// server/test/relay-store.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../lib/relay/store.js';

function fakeDb(rows = []) {
  const state = { rows: [...rows], updates: [] };
  return {
    state,
    async insert(row) { state.rows.push({ id: `e${state.rows.length + 1}`, ...row }); return state.rows.at(-1); },
    async listOpen(businessId) {
      return state.rows.filter(r => r.business_id === businessId && r.status === 'open')
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    },
    async listAllOpen() { return state.rows.filter(r => r.status === 'open'); },
    async update(id, patch) { state.updates.push({ id, patch }); Object.assign(state.rows.find(r => r.id === id) ?? {}, patch); },
  };
}

test('nextShortCode starts at 1 and avoids codes already open', async () => {
  store._setDbForTest(fakeDb([
    { id: 'e1', business_id: 'b1', status: 'open', short_code: 1, created_at: '2026-07-25T10:00:00Z' },
  ]));
  assert.equal(await store.nextShortCode('b1'), 2);
});

test('nextShortCode recycles past 99 rather than growing forever', async () => {
  const rows = Array.from({ length: 99 }, (_, i) => ({
    id: `e${i}`, business_id: 'b1', status: 'open', short_code: i + 1, created_at: '2026-07-25T10:00:00Z',
  }));
  store._setDbForTest(fakeDb(rows));
  const code = await store.nextShortCode('b1');
  assert.ok(code >= 1 && code <= 99);
});

test('listOpen returns newest first', async () => {
  store._setDbForTest(fakeDb([
    { id: 'old', business_id: 'b1', status: 'open', short_code: 1, created_at: '2026-07-25T10:00:00Z' },
    { id: 'new', business_id: 'b1', status: 'open', short_code: 2, created_at: '2026-07-25T12:00:00Z' },
  ]));
  const rows = await store.listOpen('b1');
  assert.equal(rows[0].id, 'new');
});

test('markAnswered records the raw human text and stamps answered_at', async () => {
  const db = fakeDb([{ id: 'e1', business_id: 'b1', status: 'open' }]);
  store._setDbForTest(db);
  await store.markAnswered('e1', 'כן, עד 3 תשלומים');
  const { patch } = db.state.updates[0];
  assert.equal(patch.status, 'answered');
  assert.equal(patch.answer, 'כן, עד 3 תשלומים');
  assert.ok(patch.answered_at);
});

test('recordNudge increments the counter and stamps the time', async () => {
  const db = fakeDb([{ id: 'e1', business_id: 'b1', status: 'open', nudge_count: 1 }]);
  store._setDbForTest(db);
  await store.recordNudge('e1');
  assert.equal(db.state.updates[0].patch.nudge_count, 2);
  assert.ok(db.state.updates[0].patch.last_nudge_at);
});
