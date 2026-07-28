-- Every rep-facing message id for an open escalation, not just the first.
--
-- raiseEscalation stores the id of the original message in rep_message_id, and
-- correlation matches a rep's quote-reply against it. But nudgePass sends a
-- SECOND message to the same rep, and a nudge is by construction the newest
-- message in that thread — so it is the one a rep naturally quote-replies to.
-- That id matched nothing, a natural-language answer carries no leading '#N',
-- and correlation fell through to matchedBy:'recent', delivering the answer to
-- whichever escalation was newest rather than the one the rep was reminded
-- about. On a tenant with two open escalations that is a wrong-lead delivery.
--
-- store.attachNudgeMessageId appends here; correlate.js matches rep_message_id
-- OR any element of this array.
--
-- Applied to production 2026-07-28 (escalations was empty at the time, so the
-- default backfilled nothing). The code degrades correctly without it: an
-- absent or empty array simply falls back to the previous code/single/recent
-- ladder, and there is a test pinning that pre-DDL behaviour.
begin;

alter table escalations
  add column if not exists rep_message_ids text[] not null default '{}';

comment on column escalations.rep_message_ids is
  'Every message id sent to the rep for this escalation (original + nudges). A quote-reply matching any element correlates to this row.';

commit;
