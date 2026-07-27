-- Evaluation accounts: let a prospect edit the bot policy of one specific
-- business from the client portal.
--
-- Default false, so every existing and future business keeps the policy lock.
-- The flag lives here on `businesses` and never on `business_profiles`, which
-- is the table the portal write path touches — so a client can never grant
-- themselves the permission that governs their own writes.
begin;

alter table businesses
  add column if not exists portal_full_edit boolean not null default false;

comment on column businesses.portal_full_edit is
  'Evaluation/demo only: allows the client portal to edit guardrails, persona, agent_mode, cta_goal and push_speed. Off for real clients — bot policy is operator-managed.';

commit;
