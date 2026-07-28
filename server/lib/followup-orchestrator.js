// Orchestrates one call to POST /follow-up/process: the stale-lead
// follow-up sweep and the rep-nudge pass (human-rep-relay Task 8) are two
// unrelated features that happen to share a scheduling slot.
//
// followup_enabled is a per-business, separately-toggled opt-in for chasing
// stale leads. It has no relationship to whether a business uses
// escalations. So the follow-up business list being empty — or simply not
// including a given business because that business never turned follow-ups
// on — must never suppress the nudge pass: every open escalation everywhere
// must still get its turn, or a rep silently stops being reminded the
// moment nobody happens to have follow-ups enabled.
//
// Symmetrically, a failure inside the nudge pass (e.g. a transient DB error
// from store.listAllOpen()) must not discard follow-up results that were
// already computed successfully — that would violate the fails-soft
// constraint at the one point where two independent features share a
// response. The failure is logged by the caller-supplied runNudges and
// reported back as `nudges.error` instead of throwing.
export async function runFollowUpsAndNudges({ businesses, runFollowUps, runNudges }) {
  const results = (businesses && businesses.length) ? await runFollowUps(businesses) : [];

  let nudges;
  try {
    nudges = await runNudges();
  } catch (e) {
    console.error('[followup-orchestrator] nudge pass failed:', e.message);
    nudges = { nudged: 0, expired: 0, error: e.message };
  }

  return { results, nudges };
}
