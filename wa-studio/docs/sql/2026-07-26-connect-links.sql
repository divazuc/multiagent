-- Short connect codes for module connect links.
--
-- The signed 48h state still does the authorising; this table only maps a
-- short, dictatable code to it. A 147-character state URL wraps in terminals
-- and chat clients, and one shifted character fails the HMAC — which is
-- exactly how the first calendar connect attempt failed.
begin;

create table if not exists connect_links (
  code         text primary key,
  business_id  uuid not null references businesses(id),
  module_key   text not null,
  state        text not null,
  expires_at   timestamptz not null,
  used_at      timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists connect_links_biz_idx on connect_links (business_id, module_key);

alter table connect_links enable row level security;
revoke all on connect_links from anon, authenticated;

commit;
