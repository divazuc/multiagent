-- wa-studio/docs/sql/2026-07-25-relay.sql
-- Human-rep relay: people + open escalations. Apply once.
begin;

create table if not exists business_contacts (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id),
  role         text not null check (role in ('owner','rep')),
  name         text,
  phone        text,
  email        text,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (business_id, role)
);
create index if not exists business_contacts_phone_idx on business_contacts (phone);

create table if not exists escalations (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id),
  session_id      text not null,
  short_code      int  not null,
  question        text not null,
  reason          text,
  summary         text,
  rep_phone       text not null,
  rep_message_id  text,
  status          text not null default 'open',
  answer          text,
  nudge_count     int  not null default 0,
  last_nudge_at   timestamptz,
  created_at      timestamptz not null default now(),
  answered_at     timestamptz
);
create index if not exists escalations_open_idx on escalations (business_id, status, created_at desc);
create index if not exists escalations_rep_msg_idx on escalations (rep_message_id);

alter table business_contacts enable row level security;
alter table escalations       enable row level security;
revoke all on business_contacts from anon, authenticated;
revoke all on escalations       from anon, authenticated;

-- Non-destructive owner backfill. Legacy columns are left untouched.
insert into business_contacts (business_id, role, name, email, phone)
select b.id, 'owner',
       coalesce(b.contact_name, b.owner_name, p.contact_name),
       coalesce(b.contact_email, p.contact_email),
       regexp_replace(coalesce(b.phone, p.contact_phone, ''), '\D', '', 'g')
from businesses b
left join business_profiles p on p.business_id = b.id::text
on conflict (business_id, role) do nothing;

-- Expand Israeli leading 0 on backfilled rows.
update business_contacts
set phone = '972' || substring(phone from 2)
where phone like '0%';

update business_contacts set phone = null
where phone is not null and phone !~ '^\d{10,15}$';

commit;
