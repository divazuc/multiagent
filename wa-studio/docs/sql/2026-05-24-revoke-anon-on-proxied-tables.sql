-- 2026-05-24 — Revoke anon/authenticated access from tables now proxied through the server
--
-- All 7 RLS-on tables that still leaked after the 2026-05-20 migration are now
-- accessed exclusively via the Express /data/* endpoints, which use the
-- service_role key (bypasses RLS). No frontend code touches these tables
-- directly anymore, so we can safely revoke all grants from anon/authenticated.
--
-- Run in Supabase SQL Editor (or via psql).

REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.agent_runs,
  public.business_profiles,
  public.businesses,
  public.conversation_messages,
  public.knowledge_items,
  public.sessions,
  public.setup_drafts
FROM anon, authenticated;

-- The conversations view joins conversation_messages — revoke it too
REVOKE SELECT ON public.conversations FROM anon, authenticated;

-- Drop the permissive RLS policies that were allowing anon read
-- (the tables still have RLS enabled; with no policies the default is DENY)
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'agent_runs','business_profiles','businesses',
        'conversation_messages','knowledge_items','sessions','setup_drafts'
      )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
      r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;
