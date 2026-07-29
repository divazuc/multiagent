import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthPayload } from '../lib/health.js';

// /health used to return a static {ok:true}, so "did the deploy land?" could
// only ever be assumed. Railway injects RAILWAY_GIT_COMMIT_SHA for
// GitHub-linked services, so surfacing it turns that into a question with an
// answer — compare it against `git rev-parse HEAD`.

test('the payload still reports ok so existing health checks keep passing', () => {
  assert.equal(healthPayload({}).ok, true);
});

test('the running commit is reported when the platform provides it', () => {
  const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  assert.equal(healthPayload({ RAILWAY_GIT_COMMIT_SHA: sha }).commit, sha);
});

// The KEY is the fingerprint, not the value. A build predating this change has
// no `commit` key at all, so `'commit' in payload` distinguishes "new build
// that doesn't know its sha" from "old build" — which is exactly the case that
// left me unable to verify a deploy from outside.
test('the commit key is present but null when the platform does not provide it', () => {
  const payload = healthPayload({});
  assert.ok('commit' in payload, 'the key must exist so an old build is distinguishable from a shaless new one');
  assert.equal(payload.commit, null);
});

test('an empty or whitespace sha is reported as null rather than a blank string', () => {
  assert.equal(healthPayload({ RAILWAY_GIT_COMMIT_SHA: '' }).commit, null);
  assert.equal(healthPayload({ RAILWAY_GIT_COMMIT_SHA: '   ' }).commit, null);
});

test('it reads the real environment when no override is passed', () => {
  const saved = process.env.RAILWAY_GIT_COMMIT_SHA;
  try {
    process.env.RAILWAY_GIT_COMMIT_SHA = 'deadbeef';
    assert.equal(healthPayload().commit, 'deadbeef');
  } finally {
    if (saved === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
    else process.env.RAILWAY_GIT_COMMIT_SHA = saved;
  }
});
