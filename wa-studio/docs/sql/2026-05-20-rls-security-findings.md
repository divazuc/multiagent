# Supabase security findings — 2026-05-20

Triggered by Supabase advisor warnings `rls_disabled_in_public` + `sensitive_columns_exposed`. Live probing with the publishable key (i.e. what any visitor with the project URL holds) revealed a problem much larger than those two advisors describe.

## What the advisor flagged

- 15 tables in `public` with RLS disabled.
- Sensitive columns (phone, email, phone_number_id) reachable via the Data API.

## What live probing also revealed

Every probe below was run with the project's `sb_publishable_*` key — exactly what an unauthenticated visitor to the site can extract from the JS bundle. PostgREST returned the data for anon.

| Table / view             | RLS    | Anon read? | Rows reachable |
| ------------------------ | ------ | ---------- | -------------- |
| admin_sessions           | off    | yes        | 0 (empty)      |
| automation_logs          | off    | yes        | 0              |
| business_config          | off    | yes        | 0              |
| business_persona         | off    | yes        | 0              |
| business_usage_daily     | off    | yes        | 0              |
| business_usage_monthly   | off    | yes        | 0              |
| chat_sessions            | off    | yes        | 1              |
| **contacts**             | off    | **yes**    | **23** (real customer phones)  |
| external_leads_sources   | off    | yes        | 0              |
| lead_followups           | off    | yes        | 0              |
| messages                 | off    | yes        | 0              |
| prod_conversations       | off    | yes        | 0              |
| prod_messages            | off    | yes        | 0              |
| **wa_billing_events**    | off    | **yes**    | **20**         |
| webhook_logs             | off    | yes        | 0              |
| agent_runs               | **on** | **yes**    | **46**         |
| **business_profiles**    | on     | **yes**    | **33** (persona, sales goals) |
| **businesses**           | on     | **yes**    | **50** (phone, phone_number_id, contact_email) |
| **conversation_messages**| on     | **yes**    | **35** (full message bodies)  |
| knowledge_items          | on     | yes        | 22             |
| sessions                 | on     | yes        | 54             |
| setup_drafts             | on     | yes        | 52             |
| **conversations** (view) | n/a    | **yes**    | **70**         |

Every public table is fully readable to any visitor. The seven "RLS-enabled" tables have policies, but those policies effectively allow anon read (otherwise the wa-studio + biz-dashboard frontends wouldn't function with their publishable key).

Additionally, `information_schema.role_table_grants` showed `anon` and `authenticated` hold **`DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE`** on every public table. `TRUNCATE` bypasses RLS entirely — so the seven RLS-on tables are also wipeable by any visitor.

## What the migration in `2026-05-20-enable-rls-and-tighten-grants.sql` fixes

1. Enables RLS on the 15 disabled tables.
2. Revokes `TRUNCATE, TRIGGER, REFERENCES` from anon/authenticated on every public table (and from default privileges going forward).

That's enough to clear both advisor warnings and stop anyone from `TRUNCATE`-ing your tables, but **it does NOT stop anon SELECT on the seven existing RLS-on tables.** Those keep leaking because:

- They already have policies that effectively say "anyone can read".
- The frontend (wa-studio + biz-dashboard) directly depends on that anon read access to function.
- The `conversations` view sits on top of `conversation_messages` and inherits the same exposure (or worse — views bypass RLS by default unless created `WITH (security_invoker = true)`).

## What's not fixed and needs an architectural decision

The 7 RLS-on tables + the `conversations` view will continue to leak after the migration. The proper fix depends on which path you want for the frontends. Three options:

### Option 1 — Move all frontend reads through the agent server
- Frontend never touches Supabase directly. Every read becomes a call to a server endpoint.
- Agent server uses `service_role` (bypasses RLS) and enforces access in code.
- Pros: simplest model; one place to reason about access.
- Cons: lots of new server endpoints to write; frontend rewrites; latency.

### Option 2 — Supabase Auth + per-business JWT claims
- Each business owner signs in via Supabase Auth. Their JWT carries `business_id` in `app_metadata`.
- RLS policies on every table check `business_id = (auth.jwt() -> 'app_metadata' ->> 'business_id')`.
- Pros: native Supabase pattern; works with existing `from('businesses').select(...)` calls.
- Cons: requires real auth (the current Login.jsx is just an env-var gate); requires admin views to use a separate role.

### Option 3 — Hybrid: tighten the policies on the 7 tables today; defer architecture
- Replace the permissive policies with `service_role`-only policies (i.e. RLS denies anon/authenticated).
- Frontends move to calling the agent server for ALL data — same end state as Option 1 but staged.
- Pros: stops the bleed immediately; lets you refactor frontends incrementally.
- Cons: frontends stop working until each read is routed through the server.

## My recommendation

For an immediate posture improvement without breaking everything: **run the migration as written** (clears the advisor + closes the TRUNCATE vector), then pick Option 1 or 2 for the longer-term fix. Option 1 is simpler to ship, Option 2 is cleaner long-term.

In the meantime, the `contacts.phone` column is the most acute exposure — 23 real customer phone numbers reachable by anyone with the publishable key. Worth prioritising even if the full architectural fix takes a few weeks.

## How to reproduce the probe

```bash
PUB_KEY=$(grep '^VITE_SUPABASE_ANON_KEY=' wa-studio/.env.local | cut -d= -f2-)
curl -s -I \
  -H "apikey: $PUB_KEY" \
  -H "Authorization: Bearer $PUB_KEY" \
  -H "Range-Unit: items" \
  -H "Prefer: count=exact" \
  "https://mlbtqspcgdprmbytcsyc.supabase.co/rest/v1/contacts?select=*&limit=0"
```

After the migration, the same probe against any RLS-off → RLS-on table should return `count=0` (because no anon policy exists). The 7 RLS-on tables will continue to return real counts until their policies are tightened.
