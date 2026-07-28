// server/test/studio-contacts.test.js
//
// server/lib/studio.js and server/lib/portal.js both import ../lib/supabase.js
// at the top level, which calls createClient(...) immediately and throws if
// SUPABASE_URL / SUPABASE_SERVICE_KEY are unset. Dummy values below let the
// modules load; every op exercised here goes through relay/contacts.js's own
// _setDbForTest seam instead of touching a real client.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:0';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const { runStudioOp } = await import('../lib/studio.js');
const { runPortalOp } = await import('../lib/portal.js');
const contacts = await import('../lib/relay/contacts.js');

function fakeContactsDb(rows = []) {
  const state = { rows: [...rows], upserts: [] };
  return {
    state,
    async listContacts(businessId) { return state.rows.filter(r => r.business_id === businessId); },
    async upsertContact(row) { state.upserts.push(row); },
  };
}

test('getBusinessContacts returns {owner, rep}, nulling out a missing role', async () => {
  contacts._setDbForTest(fakeContactsDb([
    { business_id: 'b1', role: 'owner', name: 'דיוה', phone: '972548139333' },
  ]));
  const result = await runStudioOp('getBusinessContacts', ['b1']);
  assert.equal(result.owner.name, 'דיוה');
  assert.equal(result.rep, null);
});

test('getBusinessContacts does not leak another business\'s contacts', async () => {
  contacts._setDbForTest(fakeContactsDb([
    { business_id: 'b2', role: 'owner', name: 'אחר', phone: '972500000002' },
  ]));
  const result = await runStudioOp('getBusinessContacts', ['b1']);
  assert.equal(result.owner, null);
  assert.equal(result.rep, null);
});

test('setBusinessContact rejects an invalid role before touching the database', async () => {
  const db = fakeContactsDb([]);
  contacts._setDbForTest(db);
  await assert.rejects(
    () => runStudioOp('setBusinessContact', ['b1', 'admin', { name: 'x' }]),
    /invalid role/i,
  );
  assert.equal(db.state.upserts.length, 0, 'must not touch the database for an invalid role');
});

for (const role of ['owner', 'rep']) {
  test(`setBusinessContact upserts a valid '${role}' contact`, async () => {
    const db = fakeContactsDb([]);
    contacts._setDbForTest(db);
    const result = await runStudioOp('setBusinessContact', ['b1', role, { name: 'סאלי', phone: '972500000001' }]);
    assert.deepEqual(result, { ok: true });
    assert.equal(db.state.upserts[0].role, role);
    assert.equal(db.state.upserts[0].business_id, 'b1');
    assert.equal(db.state.upserts[0].phone, '972500000001');
  });
}

test('setBusinessContact defaults missing fields to null rather than dropping them', async () => {
  const db = fakeContactsDb([]);
  contacts._setDbForTest(db);
  await runStudioOp('setBusinessContact', ['b1', 'rep', { name: 'סאלי' }]);
  const row = db.state.upserts[0];
  assert.equal(row.phone, null);
  assert.equal(row.email, null);
  assert.equal(row.notes, null);
});

test('setBusinessContact surfaces an unusable-phone error instead of swallowing it', async () => {
  contacts._setDbForTest(fakeContactsDb([]));
  await assert.rejects(
    () => runStudioOp('setBusinessContact', ['b1', 'rep', { phone: '123' }]),
    /phone/i,
  );
});

test('setBusinessContact clears a phone on an empty string rather than rejecting it', async () => {
  const db = fakeContactsDb([]);
  contacts._setDbForTest(db);
  await runStudioOp('setBusinessContact', ['b1', 'rep', { name: 'סאלי', phone: '' }]);
  assert.equal(db.state.upserts[0].phone, null);
});

test('an unknown studio op still rejects the same way it always has', async () => {
  await assert.rejects(() => runStudioOp('setBusinessContactTypo', ['b1', 'rep', {}]), /unknown studio op/i);
});

// ── Portal whitelist: read the two contacts, never write them ───────────────

test('the portal whitelist exposes getBusinessContacts read-only, business_id from the token', async () => {
  contacts._setDbForTest(fakeContactsDb([
    { business_id: 'b1', role: 'rep', name: 'סאלי', phone: '972500000001' },
  ]));
  const result = await runPortalOp('b1', 'getBusinessContacts', []);
  assert.equal(result.rep.name, 'סאלי');
  assert.equal(result.owner, null);
});

test('the portal whitelist does NOT expose setBusinessContact', async () => {
  contacts._setDbForTest(fakeContactsDb([]));
  await assert.rejects(
    () => runPortalOp('b1', 'setBusinessContact', ['owner', { phone: '972500000009' }]),
    /unknown portal op/i,
  );
});

test('the portal whitelist strips internal operator notes before they reach the client', async () => {
  contacts._setDbForTest(fakeContactsDb([
    { business_id: 'b1', role: 'owner', name: 'דיוה', phone: '972548139333', email: 'd@x.com', notes: 'מנהלת מכירות, זמינה רק בבקרים' },
    { business_id: 'b1', role: 'rep', name: 'סאלי', phone: '972500000001', notes: 'internal: escalate pricing only' },
  ]));
  const result = await runPortalOp('b1', 'getBusinessContacts', []);
  assert.deepEqual(result.owner, { name: 'דיוה', phone: '972548139333', email: 'd@x.com' });
  assert.equal('notes' in result.owner, false, 'notes must not be present at all, not just falsy');
  assert.equal('notes' in result.rep, false);
});
