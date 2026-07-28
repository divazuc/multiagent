-- Per-business nudge cadence for open escalations.
--
-- nudgePass() (server/lib/relay/index.js) already accepts intervalHours and
-- maxNudges, but server/index.js's runNudges caller does not pass them yet —
-- it runs on the function's hardcoded defaults (2h / 4 nudges) for every
-- business today. These two columns let an operator override that per
-- business from the admin UI (BotPolicyEditor); wiring runNudges to read them
-- is follow-up work, not part of this migration.
--
-- IMPORTANT — apply this BEFORE deploying the code that adds these columns to
-- studio.js's getBotSettings() select list. PostgREST returns a hard 400 for
-- the whole request when a selected column does not exist, so deploying the
-- code first breaks getBotSettings for every business (admin BotPolicyEditor,
-- the demo dashboard, and the real client portal all call it).
begin;

alter table business_profiles
  add column if not exists nudge_interval_hours integer not null default 2,
  add column if not exists nudge_max_count      integer not null default 4;

comment on column business_profiles.nudge_interval_hours is
  'Hours between reminder nudges to the rep for an open escalation. Default 2, matches nudgePass()''s built-in default.';
comment on column business_profiles.nudge_max_count is
  'Nudges sent before an open escalation is marked expired. Default 4, matches nudgePass()''s built-in default.';

commit;
