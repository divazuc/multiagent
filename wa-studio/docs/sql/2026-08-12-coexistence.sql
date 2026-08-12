-- WhatsApp Coexistence (server/lib/coexistence.js) — apply once in the
-- Supabase SQL editor BEFORE seeding the first coexistence tenant.
--
-- The server code fails soft while these columns are absent (every lookup
-- catches the missing-column error and behaves as "coexistence off"), so
-- applying this is safe at any time — but the CrossFit Kids tenant's owner
-- standdown only actually works after it is applied.
begin;

alter table business_profiles
  add column if not exists coexistence boolean not null default false,
  add column if not exists coexistence_standdown_minutes integer not null default 720;

comment on column business_profiles.coexistence is
  'This business runs WhatsApp Coexistence: the owner keeps using the WhatsApp Business app on the bot''s number. Gates the owner-reply standdown (server/lib/coexistence.js).';
comment on column business_profiles.coexistence_standdown_minutes is
  'How long the bot stays silent in a conversation after the owner answered it from the app. Default 720 = 12h.';

alter table sessions
  add column if not exists coexistence_standdown_until timestamptz;

comment on column sessions.coexistence_standdown_until is
  'Bot is silent in this conversation until this time (set by an owner echo on a coexistence business; null/past = bot answers normally).';

commit;
