import test from 'node:test';
import assert from 'node:assert/strict';
import * as connect from '../lib/modules/connect.js';

function fakeDb() {
  const state = { rows: [] };
  return {
    state,
    async insert(row) { state.rows.push(row); },
    async findByCode(code) { return state.rows.find(r => r.code === code) ?? null; },
    async markUsed(code) { const r = state.rows.find(x => x.code === code); if (r) r.used_at = 'now'; },
  };
}

test('encodeCode maps every byte to one alphabet character', () => {
  const code = connect.encodeCode(Uint8Array.from([0, 1, 2, 3, 4, 5]));
  assert.equal(code.length, 6);
  for (const ch of code) assert.ok(connect.ALPHABET.includes(ch), `${ch} not in alphabet`);
});

test('the alphabet excludes characters people confuse when reading a code aloud', () => {
  for (const ch of ['0', 'O', '1', 'I', 'L']) {
    assert.ok(!connect.ALPHABET.includes(ch), `${ch} must not be in the alphabet`);
  }
});

test('encodeCode is deterministic for the same bytes', () => {
  const bytes = Uint8Array.from([9, 40, 200, 7, 61, 128]);
  assert.equal(connect.encodeCode(bytes), connect.encodeCode(bytes));
});

test('createConnectCode stores the signed state and returns a short code', async () => {
  const db = fakeDb();
  connect._setDbForTest(db);
  const code = await connect.createConnectCode({
    businessId: 'b1', moduleKey: 'calendar', state: 'payload.signature', ttlMs: 48 * 3600 * 1000,
  });
  assert.equal(code.length, 6);
  assert.equal(db.state.rows.length, 1);
  assert.equal(db.state.rows[0].state, 'payload.signature');
  assert.equal(db.state.rows[0].business_id, 'b1');
});

test('resolveConnectCode returns the state for a live code', async () => {
  const db = fakeDb();
  connect._setDbForTest(db);
  const code = await connect.createConnectCode({
    businessId: 'b1', moduleKey: 'calendar', state: 'payload.signature', ttlMs: 60_000,
  });
  const found = await connect.resolveConnectCode(code);
  assert.equal(found.state, 'payload.signature');
});

test('resolveConnectCode is case-insensitive so a dictated code still works', async () => {
  const db = fakeDb();
  connect._setDbForTest(db);
  const code = await connect.createConnectCode({
    businessId: 'b1', moduleKey: 'calendar', state: 'payload.signature', ttlMs: 60_000,
  });
  const found = await connect.resolveConnectCode(code.toLowerCase());
  assert.equal(found.state, 'payload.signature');
});

test('an unknown code resolves to null', async () => {
  connect._setDbForTest(fakeDb());
  assert.equal(await connect.resolveConnectCode('ZZZZZZ'), null);
});

test('an expired code resolves to null even though the row still exists', async () => {
  const db = fakeDb();
  connect._setDbForTest(db);
  const code = await connect.createConnectCode({
    businessId: 'b1', moduleKey: 'calendar', state: 'payload.signature', ttlMs: -1000,
  });
  assert.equal(await connect.resolveConnectCode(code), null);
  assert.equal(db.state.rows.length, 1, 'the row is kept for audit, only the resolve fails');
});

test('resolving marks the code used without preventing a reload', async () => {
  const db = fakeDb();
  connect._setDbForTest(db);
  const code = await connect.createConnectCode({
    businessId: 'b1', moduleKey: 'calendar', state: 'payload.signature', ttlMs: 60_000,
  });
  await connect.resolveConnectCode(code);
  assert.equal(db.state.rows[0].used_at, 'now');
  const again = await connect.resolveConnectCode(code);
  assert.equal(again.state, 'payload.signature', 'a reload of the consent page must still work');
});
