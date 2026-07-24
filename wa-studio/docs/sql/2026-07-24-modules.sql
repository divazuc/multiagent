-- Modules infrastructure (spec: docs/superpowers/specs/2026-07-24-modules-calendar-design.md)
-- Apply once in Supabase SQL Editor.
begin;

create table if not exists business_modules (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id),
  module_key    text not null,
  enabled       boolean not null default false,
  settings      jsonb not null default '{}',
  secrets       jsonb not null default '{}',
  status        text not null default 'disconnected',
  status_detail text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (business_id, module_key)
);

create table if not exists module_events (
  id           bigint generated always as identity primary key,
  business_id  uuid not null,
  module_key   text not null,
  event_type   text not null,
  detail       jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists module_events_biz_idx on module_events (business_id, module_key, created_at desc);

alter table business_modules enable row level security;
alter table module_events enable row level security;
revoke all on business_modules from anon, authenticated;
revoke all on module_events from anon, authenticated;

commit;
