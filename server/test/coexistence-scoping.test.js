// Pilot finding #1 (2026-08-12, live): the owner of the kids business replied
// from her phone — a phone that ALSO holds a session with the DIVAZ business —
// and the standdown write landed on the session row whose business_id was
// DIVAZ, because the store matched by session_id alone. These tests run the
// REAL store implementation (lib/coexistence.js#_realDbWith) against an
// in-memory supabase fake, under both the pre- and post-migration sessions
// schema (docs/sql/2026-08-13-sessions-per-business.sql).

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://supabase.invalid';
process.env.SUPABASE_SERVICE_KEY = 'stub-service-key';

const coex = await import('../lib/coexistence.js');
const { _realDbWith, _setDbForTest, handleOwnerEcho, standdownActive, sendUnlessStoodDown, _clearInboundForTest } = coex;
const { fakeSupabase } = await import('./helpers/fake-supabase.js');

// Leads bookkeeping is exercised in its own tests — read as disabled here.
const leadsLib = await import('../lib/leads.js');
leadsLib._setDbForTest({ isEnabled: async () => false });

// The live cast: one phone, two tenants.
const KIDS = 'f53bdccc-kids';
const DIVAZ = '86efa161-divaz';
const PNID_KIDS = 'pnid-kids-333';
const PNID_DIVAZ = 'pnid-divaz-555';
const OWNER_PHONE = '972528250088';

const POST = [['session_id', 'business_id']]; // migrated: unique per pair
const PRE = [['session_id']];                 // today: unique per session_id

function seeded({ unique = POST, sessions = [] } = {}) {
  return fakeSupabase({
    tables: {
      businesses: [
        { id: KIDS, wa_phone_number_id: PNID_KIDS },
        { id: DIVAZ, wa_phone_number_id: PNID_DIVAZ },
      ],
      business_profiles: [
        { business_id: KIDS, coexistence: true, coexistence_standdown_minutes: 720, standdown_echo_grace_seconds: 25 },
        { business_id: DIVAZ, coexistence: false, coexistence_standdown_minutes: 720, standdown_echo_grace_seconds: 25 },
      ],
      sessions,
      conversation_messages: [],
    },
    uniques: { sessions: unique },
  });
}

const divazRow = (extra = {}) => ({
  session_id: OWNER_PHONE, business_id: DIVAZ, session_mode: 'live',
  current_stage: 'payment_pending', setup_completed: true,
  coexistence_standdown_until: null, updated_at: '2026-08-12T08:00:00Z', ...extra,
});
const kidsRow = (extra = {}) => ({
  session_id: OWNER_PHONE, business_id: KIDS, session_mode: 'live',
  current_stage: 'greeting', setup_completed: true,
  coexistence_standdown_until: null, updated_at: '2026-08-12T09:00:00Z', ...extra,
});

const kidsEcho = { msgId: 'wamid.OWNER', phoneNumberId: PNID_KIDS, recipient: OWNER_PHONE, text: 'תכף אחזור אלייך' };

test.beforeEach(() => _clearInboundForTest());
test.afterEach(() => _setDbForTest(null));

// ── Write scoping ────────────────────────────────────────────────────────────

test('THE pilot regression: kids echo stands down the kids row only — Divaz untouched', async () => {
  const fake = seeded({ sessions: [divazRow(), kidsRow()] });
  _setDbForTest(_realDbWith(fake));

  const now = new Date('2026-08-12T20:00:00Z');
  const r = await handleOwnerEcho(kidsEcho, now);
  assert.equal(r.standdown, true);

  const divaz = fake.tables.sessions.find(s => s.business_id === DIVAZ);
  const kids = fake.tables.sessions.find(s => s.business_id === KIDS);
  assert.equal(kids.coexistence_standdown_until, new Date('2026-08-13T08:00:00Z').toISOString());
  assert.equal(divaz.coexistence_standdown_until, null, 'the DIVAZ session row must never be touched');
  assert.equal(divaz.updated_at, '2026-08-12T08:00:00Z');
});

test('no kids row yet (post-migration): the standdown INSERTS a kids-bound session, Divaz untouched', async () => {
  const fake = seeded({ sessions: [divazRow()] });
  _setDbForTest(_realDbWith(fake));

  const r = await handleOwnerEcho(kidsEcho, new Date('2026-08-12T20:00:00Z'));
  assert.equal(r.standdown, true);
  assert.equal(fake.tables.sessions.length, 2);

  const inserted = fake.tables.sessions.find(s => s.business_id === KIDS);
  assert.equal(inserted.session_id, OWNER_PHONE);
  assert.equal(inserted.session_mode, 'live');
  assert.ok(inserted.coexistence_standdown_until);

  const divaz = fake.tables.sessions.find(s => s.business_id === DIVAZ);
  assert.equal(divaz.coexistence_standdown_until, null);
});

test('pre-migration schema, foreign-bound row: standdown is NOT armed and the other row is NOT touched', async () => {
  // Today's DB: unique(session_id), and the phone's one row belongs to Divaz.
  // The scoped update matches nothing; the insert violates the old constraint.
  // The only acceptable outcome is "no standdown" — never a write to Divaz.
  const fake = seeded({ unique: PRE, sessions: [divazRow()] });
  _setDbForTest(_realDbWith(fake));

  const r = await handleOwnerEcho(kidsEcho, new Date('2026-08-12T20:00:00Z'));
  assert.equal(r.standdown, false);
  assert.equal(r.reason, 'error');

  assert.equal(fake.tables.sessions.length, 1);
  assert.equal(fake.tables.sessions[0].business_id, DIVAZ);
  assert.equal(fake.tables.sessions[0].coexistence_standdown_until, null);
});

test('single-business phone (the common case): standdown lands exactly as before', async () => {
  const fake = seeded({ unique: PRE, sessions: [kidsRow()] });
  _setDbForTest(_realDbWith(fake));
  const r = await handleOwnerEcho(kidsEcho, new Date('2026-08-12T20:00:00Z'));
  assert.equal(r.standdown, true);
  assert.equal(fake.tables.sessions[0].coexistence_standdown_until, new Date('2026-08-13T08:00:00Z').toISOString());
});

// ── Read scoping — both directions ───────────────────────────────────────────

test('a Divaz standdown does not silence the kids bot for the same phone', async () => {
  const fake = seeded({
    sessions: [divazRow({ coexistence_standdown_until: '2026-08-13T08:00:00Z' }), kidsRow()],
  });
  _setDbForTest(_realDbWith(fake));

  const now = new Date('2026-08-12T21:00:00Z');
  assert.equal(await standdownActive(OWNER_PHONE, { businessId: DIVAZ }, now), true);
  assert.equal(await standdownActive(OWNER_PHONE, { businessId: KIDS }, now), false,
    'kids bot must keep answering');
});

test('and vice versa: a kids standdown does not silence the Divaz bot', async () => {
  const fake = seeded({
    sessions: [divazRow(), kidsRow({ coexistence_standdown_until: '2026-08-13T08:00:00Z' })],
  });
  _setDbForTest(_realDbWith(fake));

  const now = new Date('2026-08-12T21:00:00Z');
  assert.equal(await standdownActive(OWNER_PHONE, { businessId: KIDS }, now), true);
  assert.equal(await standdownActive(OWNER_PHONE, { businessId: DIVAZ }, now), false);
});

test('standdownActive can resolve the business from the receiving number (unsupported-media path)', async () => {
  const fake = seeded({
    sessions: [divazRow({ coexistence_standdown_until: '2026-08-13T08:00:00Z' }), kidsRow()],
  });
  _setDbForTest(_realDbWith(fake));

  const now = new Date('2026-08-12T21:00:00Z');
  assert.equal(await standdownActive(OWNER_PHONE, { phoneNumberId: PNID_KIDS }, now), false);
  assert.equal(await standdownActive(OWNER_PHONE, { phoneNumberId: PNID_DIVAZ }, now), true);
});

test('sendUnlessStoodDown is scoped: the other tenant standing down never cancels this send', async () => {
  const fake = seeded({
    sessions: [divazRow({ coexistence_standdown_until: '2026-08-13T08:00:00Z' }), kidsRow()],
  });
  _setDbForTest(_realDbWith(fake));

  const now = new Date('2026-08-12T21:00:00Z');
  let kidsSent = false;
  const kids = await sendUnlessStoodDown(OWNER_PHONE, KIDS, async () => { kidsSent = true; }, now);
  assert.deepEqual({ cancelled: kids.cancelled, sent: kidsSent }, { cancelled: false, sent: true });

  let divazSent = false;
  const divaz = await sendUnlessStoodDown(OWNER_PHONE, DIVAZ, async () => { divazSent = true; }, now);
  assert.deepEqual({ cancelled: divaz.cancelled, sent: divazSent }, { cancelled: true, sent: false });
});

// ── Pre-migration settings read (grace column absent) ────────────────────────

test('a DB without standdown_echo_grace_seconds still arms the standdown (fail-soft settings read)', async () => {
  const fake = seeded({ unique: PRE, sessions: [kidsRow()] });
  fake.tables.business_profiles = fake.tables.business_profiles.map(
    ({ standdown_echo_grace_seconds, ...rest }) => rest);
  const missing = fakeSupabase({
    tables: fake.tables,
    uniques: { sessions: PRE },
    missingColumns: { business_profiles: ['standdown_echo_grace_seconds'] },
  });
  _setDbForTest(_realDbWith(missing));

  const r = await handleOwnerEcho(kidsEcho, new Date('2026-08-12T20:00:00Z'));
  assert.equal(r.standdown, true, 'the grace column being absent must not break the standdown itself');
});
