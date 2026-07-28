// server/test/followup-orchestrator.test.js
//
// Covers the fix-round-1 findings on /follow-up/process:
//  - CRITICAL: the nudge pass must run regardless of the follow-up business
//    list (followup_enabled is an unrelated, separately-toggled opt-in and
//    must not gate escalation nudges).
//  - IMPORTANT: a throw inside the nudge pass must not discard follow-up
//    results that already succeeded, and must be reported, not swallowed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runFollowUpsAndNudges } from '../lib/followup-orchestrator.js';

test('nudges still run when there are no follow-up-enabled businesses (empty list)', async () => {
  let followUpsCalled = false;
  let nudgesCalled = false;

  const { results, nudges } = await runFollowUpsAndNudges({
    businesses: [],
    runFollowUps: async () => { followUpsCalled = true; return []; },
    runNudges: async () => { nudgesCalled = true; return { nudged: 2, expired: 0 }; },
  });

  assert.equal(followUpsCalled, false, 'no businesses means the sweep has nothing to do');
  assert.equal(nudgesCalled, true, 'the nudge pass must still get its turn');
  assert.deepEqual(results, []);
  assert.deepEqual(nudges, { nudged: 2, expired: 0 });
});

test('nudges still run when the follow-up business list is undefined (query returned nothing)', async () => {
  let nudgesCalled = false;

  const { nudges } = await runFollowUpsAndNudges({
    businesses: undefined,
    runFollowUps: async () => { throw new Error('must not be called with no businesses'); },
    runNudges: async () => { nudgesCalled = true; return { nudged: 1, expired: 0 }; },
  });

  assert.equal(nudgesCalled, true);
  assert.deepEqual(nudges, { nudged: 1, expired: 0 });
});

test('a nudge-pass failure does not discard already-computed follow-up results', async () => {
  const { results, nudges } = await runFollowUpsAndNudges({
    businesses: [{ business_id: 'b1' }],
    runFollowUps: async () => [{ session_id: 's1', status: 'sent' }],
    runNudges: async () => { throw new Error('transient db error'); },
  });

  assert.deepEqual(results, [{ session_id: 's1', status: 'sent' }],
    'follow-up work already done must survive a nudge-pass failure');
  assert.equal(nudges.nudged, 0);
  assert.equal(nudges.expired, 0);
  assert.equal(nudges.error, 'transient db error', 'the failure must be reported, not silently swallowed');
});

test('follow-ups run normally and both halves report into one result when nothing fails', async () => {
  const { results, nudges } = await runFollowUpsAndNudges({
    businesses: [{ business_id: 'b1' }],
    runFollowUps: async (list) => list.map(b => ({ business_id: b.business_id, status: 'sent' })),
    runNudges: async () => ({ nudged: 3, expired: 1 }),
  });

  assert.deepEqual(results, [{ business_id: 'b1', status: 'sent' }]);
  assert.deepEqual(nudges, { nudged: 3, expired: 1 });
});
