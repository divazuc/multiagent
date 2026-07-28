// server/test/relay-contacts.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import * as contacts from '../lib/relay/contacts.js';

function fakeDb(rows) {
  const state = { rows: [...rows], upserts: [] };
  return {
    state,
    async listContacts(businessId) { return state.rows.filter(r => r.business_id === businessId); },
    async upsertContact(row) { state.upserts.push(row); },
  };
}

const OWNER = { business_id: 'b1', role: 'owner', name: 'דיוה', phone: '972548139333' };
const REP   = { business_id: 'b1', role: 'rep',   name: 'סאלי', phone: '972500000001' };

test('resolveRep prefers the rep row', async () => {
  contacts._setDbForTest(fakeDb([OWNER, REP]));
  const r = await contacts.resolveRep('b1');
  assert.equal(r.role, 'rep');
  assert.equal(r.phone, '972500000001');
});

test('resolveRep falls back to the owner when there is no rep', async () => {
  contacts._setDbForTest(fakeDb([OWNER]));
  const r = await contacts.resolveRep('b1');
  assert.equal(r.role, 'owner');
});

test('resolveRep returns null when no contact has a phone', async () => {
  contacts._setDbForTest(fakeDb([{ ...OWNER, phone: null }]));
  assert.equal(await contacts.resolveRep('b1'), null);
});

test('findContactByPhone matches either role', async () => {
  contacts._setDbForTest(fakeDb([OWNER, REP]));
  assert.equal((await contacts.findContactByPhone('b1', '972548139333')).role, 'owner');
  assert.equal((await contacts.findContactByPhone('b1', '972500000001')).role, 'rep');
});

test('findContactByPhone normalises the incoming number before matching', async () => {
  contacts._setDbForTest(fakeDb([OWNER]));
  assert.equal((await contacts.findContactByPhone('b1', '054-813-9333')).role, 'owner');
});

test('findContactByPhone does not leak across businesses', async () => {
  contacts._setDbForTest(fakeDb([OWNER]));
  assert.equal(await contacts.findContactByPhone('b2', '972548139333'), null);
});

test('upsertContact normalises the phone on write', async () => {
  const db = fakeDb([]);
  contacts._setDbForTest(db);
  await contacts.upsertContact('b1', 'rep', { name: 'סאלי', phone: '054-8139333' });
  assert.equal(db.state.upserts[0].phone, '972548139333');
});

test('upsertContact rejects an unusable phone instead of storing junk', async () => {
  contacts._setDbForTest(fakeDb([]));
  await assert.rejects(() => contacts.upsertContact('b1', 'rep', { phone: '123' }), /phone/i);
});
