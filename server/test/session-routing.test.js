import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionBusiness } from '../lib/session-routing.js';

const OLD = '1037d6c1-leadz';
const NEW = '86efa161-diva';

test('a session already on the right business is left alone', () => {
  const r = resolveSessionBusiness({ sessionBusinessId: NEW, businessIdFromNumber: NEW });
  assert.deepEqual(r, { businessId: NEW, corrected: false });
});

test('a stale session is re-pointed at the business that owns the number', () => {
  // The live bug: a session created in June kept routing this number to Leadz
  // long after the WhatsApp number was re-pointed to דיוה אוסט, because the
  // session's business_id won unconditionally. The owner got generic answers
  // from a business with zero active knowledge and could not see why.
  const r = resolveSessionBusiness({ sessionBusinessId: OLD, businessIdFromNumber: NEW });
  assert.deepEqual(r, { businessId: NEW, corrected: true });
});

test('with no phone_number_id the session keeps its business', () => {
  // Studio consoles and scripted tests post without a phone_number_id; they
  // must not be re-routed by an absent signal.
  const r = resolveSessionBusiness({ sessionBusinessId: OLD, businessIdFromNumber: null });
  assert.deepEqual(r, { businessId: OLD, corrected: false });
});

test('an unrecognised number never blanks a working session', () => {
  const r = resolveSessionBusiness({ sessionBusinessId: OLD, businessIdFromNumber: undefined });
  assert.equal(r.businessId, OLD);
  assert.equal(r.corrected, false);
});

test('a session with no business takes the one the number resolves to', () => {
  const r = resolveSessionBusiness({ sessionBusinessId: null, businessIdFromNumber: NEW });
  assert.deepEqual(r, { businessId: NEW, corrected: true });
});

test('neither known yields null rather than a guess', () => {
  const r = resolveSessionBusiness({ sessionBusinessId: null, businessIdFromNumber: null });
  assert.equal(r.businessId, null);
  assert.equal(r.corrected, false);
});
