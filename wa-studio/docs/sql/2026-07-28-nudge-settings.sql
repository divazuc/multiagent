-- Per-business nudge cadence for open escalations.
--
-- nudgePass() (server/lib/relay/index.js) reads these two columns per
-- business (via server/index.js's runNudges, cached per business per pass)
-- and falls back to its built-in 2h / 4-nudge defaults when a row or column
-- is missing. Set from the admin UI (BotPolicyEditor).
--
-- Applied to production 2026-07-28.
begin;

alter table business_profiles
  add column if not exists nudge_interval_hours integer not null default 2,
  add column if not exists nudge_max_count      integer not null default 4;

comment on column business_profiles.nudge_interval_hours is
  'Hours between reminder nudges to the rep for an open escalation. Default 2, matches nudgePass()''s built-in default.';
comment on column business_profiles.nudge_max_count is
  'Nudges sent before an open escalation is marked expired. Default 4, matches nudgePass()''s built-in default.';

commit;
