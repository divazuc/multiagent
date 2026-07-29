// Which commit is actually running?
//
// /health returned a static {ok:true}, so from outside there was no way to
// tell a fresh deploy from a stale one — a 200 proves the service is up, not
// which build is behind it. Railway injects RAILWAY_GIT_COMMIT_SHA for
// GitHub-linked services, so reporting it makes a deploy verifiable instead of
// assumed: compare against `git rev-parse HEAD`.
//
// `commit` is always present, even as null. A build predating this change has
// no such key at all, so the KEY's presence is itself the fingerprint that
// distinguishes an old build from a new one running without a sha.

export function healthPayload(env = process.env) {
  const sha = String(env.RAILWAY_GIT_COMMIT_SHA ?? '').trim();
  return { ok: true, commit: sha || null };
}
