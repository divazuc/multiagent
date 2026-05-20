-- ============================================================================
-- 2026-05-20 — Lock down the public schema
-- ============================================================================
-- Triggered by Supabase advisors:
--   (a) rls_disabled_in_public      — 15 tables in public schema with RLS off
--   (b) sensitive_columns_exposed   — phone / email / phone_number_id columns
--                                     reachable via Data API
--
-- Crossed with information_schema.role_table_grants, the picture was:
-- every public table had SELECT/INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER/REFERENCES
-- granted to BOTH `anon` AND `authenticated`. With RLS off, anyone with the
-- project URL and the publishable key could read or TRUNCATE the data. (Those
-- grants are Postgres' default for PUBLIC, which Supabase mirrors to its roles.)
--
-- Strategy:
--   1) Enable RLS on the 15 disabled tables.
--   2) Revoke TRUNCATE, TRIGGER, REFERENCES from anon/authenticated on every
--      public table — no legitimate frontend needs any of these.
--      Also strip them from default privileges so new tables inherit the fix.
--   3) Leave existing policies in place on the 7 already-RLS-on tables —
--      the app depends on them.
--   4) `contacts` and `wa_billing_events` already have one policy each but
--      RLS was off, so the policies were inert. Enabling RLS activates them.
--      If biz-dashboard's CRM page stops listing contacts after this runs,
--      the existing `contacts` policy is too restrictive — see the
--      `Follow-up` block at the bottom for the diagnostic + a fallback policy.
-- ============================================================================

BEGIN;

-- 1) Enable RLS on the 15 disabled tables ------------------------------------
ALTER TABLE public.admin_sessions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_logs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_config        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_persona       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_usage_daily   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_usage_monthly ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_sessions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.external_leads_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_followups         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prod_conversations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prod_messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_billing_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_logs           ENABLE ROW LEVEL SECURITY;

-- 2) Strip dangerous privileges from anon and authenticated ------------------
-- TRUNCATE is the worst: it bypasses RLS entirely, so even RLS-protected
-- tables were wipeable by anyone holding the publishable key. TRIGGER and
-- REFERENCES are unnecessary for any client role.
REVOKE TRUNCATE, TRIGGER, REFERENCES
  ON ALL TABLES IN SCHEMA public
  FROM anon, authenticated;

-- Apply the same restriction to any future tables created in public.
-- Note: ALTER DEFAULT PRIVILEGES is scoped to the role that creates the table;
-- this targets tables created by `postgres` (the role Supabase uses for DDL).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE TRUNCATE, TRIGGER, REFERENCES
  ON TABLES
  FROM anon, authenticated;

-- 3) Lock down the `conversations` view -------------------------------------
-- The view leaked 70 rows of conversation data to anon (probe 2026-05-20).
-- Only `server/lib/context.js` reads it, and it uses service_role, so
-- revoking from anon/authenticated does not break any code path.
-- (Views bypass RLS by default — even if conversation_messages had stricter
-- policies, the view would still leak. The cleanest fix is to revoke access
-- and let only service_role read it.)
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.conversations
  FROM anon, authenticated;

COMMIT;

-- ============================================================================
-- Verification — run these AFTER the COMMIT above
-- ============================================================================

-- A) Every public table should now show rls_enabled = true
SELECT relname AS table_name, relrowsecurity AS rls_enabled
FROM   pg_class c
JOIN   pg_namespace n ON n.oid = c.relnamespace
WHERE  n.nspname = 'public' AND c.relkind = 'r'
ORDER  BY relrowsecurity, relname;
-- Expected: every row has rls_enabled = true.

-- B) anon/authenticated should no longer have TRUNCATE/TRIGGER/REFERENCES
SELECT grantee, privilege_type, COUNT(*) AS tables_with_grant
FROM   information_schema.role_table_grants
WHERE  table_schema = 'public'
  AND  grantee IN ('anon', 'authenticated')
  AND  privilege_type IN ('TRUNCATE', 'TRIGGER', 'REFERENCES')
GROUP  BY grantee, privilege_type
ORDER  BY grantee, privilege_type;
-- Expected: zero rows.

-- C) Views in `public` should use security_invoker, otherwise they bypass RLS.
--    The `conversations` view (per schema.sql) reads from RLS-protected
--    tables — if `uses_security_invoker = no` it leaks data around RLS.
SELECT c.relname AS view_name,
       c.relkind,
       CASE WHEN 'security_invoker=true' = ANY(COALESCE(c.reloptions, '{}'))
            THEN 'yes' ELSE 'no' END AS uses_security_invoker,
       c.reloptions
FROM   pg_class c
JOIN   pg_namespace n ON n.oid = c.relnamespace
WHERE  n.nspname = 'public' AND c.relkind IN ('v', 'm')
ORDER  BY uses_security_invoker, c.relname;
-- For any view returning `no`: recreate as
--   CREATE OR REPLACE VIEW public.<name> WITH (security_invoker = true) AS ...

-- D) Re-run the original Supabase advisor (Dashboard → Advisors → Security).
--    `rls_disabled_in_public` and `sensitive_columns_exposed` should both
--    be cleared.


-- ============================================================================
-- Follow-up — only if biz-dashboard's CRM stops listing contacts
-- ============================================================================
-- The pre-existing `contacts` policy was inert until this migration. If
-- enabling RLS made the CRM go blank, inspect the policy:
--
--   SELECT policyname, cmd, roles, qual, with_check
--   FROM   pg_policies
--   WHERE  schemaname = 'public' AND tablename = 'contacts';
--
-- If the existing policy doesn't grant SELECT to anon, the quickest
-- temporary unblock (NOT a long-term fix — biz-dashboard should move to
-- authenticated reads or proxy through the agent server):
--
--   CREATE POLICY contacts_anon_read_temp_2026_05_20
--     ON public.contacts
--     FOR SELECT
--     TO anon
--     USING (true);
--
-- Same shape applies to `wa_billing_events` if the admin dashboard breaks.
-- ============================================================================
