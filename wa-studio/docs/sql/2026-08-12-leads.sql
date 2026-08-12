-- Leads management (ניהול לידים) — server/lib/leads.js. Apply once in the
-- Supabase SQL editor, then enable the module for the first tenant with
-- server/scripts/enable-leads-crossfit-kids.mjs.
--
-- Same convention as the coexistence columns (2026-08-12-coexistence.sql):
-- the server FAILS SOFT while this table is absent — every lead read/write
-- catches the error, the reply pipeline and the portal keep working, and the
-- board simply stays empty. Applying is therefore safe at any time; order
-- with the enable script does not matter either, only that both have run
-- before the client expects to see leads.
begin;

create table if not exists leads (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references businesses(id),
  phone            text not null,           -- normalized digits (972…), = sessions.session_id
  display_name     text,                    -- WhatsApp profile name (channel-known, customer-controlled)
  status           text not null default 'new',
  source           text default 'whatsapp',
  first_contact_at timestamptz,
  last_contact_at  timestamptz,
  last_direction   text,                    -- 'in' = customer wrote, 'out' = owner answered (echo)
  payload          jsonb not null default '{}',
  notes            text,
  status_history   jsonb not null default '[]',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (business_id, phone)
);

-- The board's two access paths: status tabs with counts, and the list sorted
-- by freshness. Both lead with business_id, which also covers the FK.
create index if not exists leads_biz_status_idx       on leads (business_id, status);
create index if not exists leads_biz_last_contact_idx on leads (business_id, last_contact_at desc);

comment on table leads is
  'ניהול לידים board (leads module, server/lib/leads.js): every number that contacted a leads-enabled business''s bot, with conversation-driven statuses. NOT the booster''s leads — this is the bot''s own per-tenant table.';
comment on column leads.status is
  'new → contacted → trial_signed_up → attended → joined / not_relevant. Valid values + Hebrew labels centralized in server/lib/leads.js#LEAD_STATUSES (deliberately no CHECK — v1 statuses will be refined by the owner). Auto transitions never downgrade; attended/joined/not_relevant are manual-only.';
comment on column leads.payload is
  'Structured trial fields captured in chat: parent_name, child_name, child_age, preferred_day (+ optional note). Merged, never replaced.';
comment on column leads.status_history is
  'Append-only [{from, to, at, by}] — by is ''auto'' (conversation), ''owner'' (portal) or ''operator'' (studio).';
comment on column leads.last_direction is
  '''in'' = last touch was the customer writing; ''out'' = the owner answering from the app (coexistence echo).';

-- Same posture as every proxied table (2026-05-24-revoke-anon-on-proxied-tables.sql):
-- RLS on with no policies (default DENY), no anon/authenticated grants — the
-- table is reached only through the server's service-role key.
alter table leads enable row level security;
revoke all on leads from anon, authenticated;

commit;
