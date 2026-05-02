-- WhatsApp AI Sales Agent — Database Schema
-- Run once in your Supabase SQL editor (Database → SQL Editor → New query)
-- Safe to re-run: all statements use IF NOT EXISTS / OR REPLACE

-- ─────────────────────────────────────────────
-- 1. Sessions
--    One row per WhatsApp conversation session
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  session_id              TEXT        PRIMARY KEY,
  business_id             TEXT,
  session_mode            TEXT        NOT NULL DEFAULT 'live_mode',  -- 'live_mode' | 'setup_mode' | 'demo_mode'
  current_stage           TEXT,
  current_setup_stage     TEXT,
  current_learning_stage  TEXT,
  setup_completed         BOOLEAN     NOT NULL DEFAULT FALSE,
  qualification_progress  JSONB       NOT NULL DEFAULT '{}',
  cta_triggered           BOOLEAN     NOT NULL DEFAULT FALSE,
  escalate                BOOLEAN     NOT NULL DEFAULT FALSE,
  simulation_history      JSONB       NOT NULL DEFAULT '[]',
  last_message_at         TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- 2. Business Profiles
--    Committed profile written at end of setup
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_profiles (
  business_id             TEXT        PRIMARY KEY,
  session_id              TEXT,
  business_name           TEXT,
  business_model          JSONB,
  sales_goal              TEXT,
  conversation_strategy   TEXT,
  services                JSONB       NOT NULL DEFAULT '[]',
  decision_logic          TEXT,
  key_questions           JSONB       NOT NULL DEFAULT '[]',
  objection_handling      JSONB       NOT NULL DEFAULT '{}',
  persona                 JSONB       NOT NULL DEFAULT '{}',
  guardrails              JSONB       NOT NULL DEFAULT '{}',
  hebrew_patterns         JSONB       NOT NULL DEFAULT '{}',
  setup_completed         BOOLEAN     NOT NULL DEFAULT FALSE,
  setup_stage             TEXT,
  draft_setup_data        JSONB       NOT NULL DEFAULT '{}',
  committed_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- 3. Setup Drafts
--    Progressive saves during onboarding flow
--    (wa_04 used to call this business_setup_drafts — now unified as setup_drafts)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS setup_drafts (
  id                  BIGSERIAL   PRIMARY KEY,
  session_id          TEXT        NOT NULL UNIQUE,  -- ON CONFLICT target
  business_id         TEXT,
  current_setup_stage TEXT,
  draft_setup_data    JSONB       NOT NULL DEFAULT '{}',
  setup_completed     BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_setup_drafts_session ON setup_drafts(session_id);

-- ─────────────────────────────────────────────
-- 4. Conversation Messages
--    One row per turn (user + agent in same row)
--    Written by wa_06
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversation_messages (
  id                      BIGSERIAL   PRIMARY KEY,
  session_id              TEXT        NOT NULL,
  business_id             TEXT,
  user_message            TEXT,
  agent_response          TEXT,
  stage                   TEXT,
  action                  TEXT,
  qualification_progress  JSONB       NOT NULL DEFAULT '{}',
  cta_triggered           BOOLEAN     NOT NULL DEFAULT FALSE,
  escalate                BOOLEAN     NOT NULL DEFAULT FALSE,
  escalation_reason       TEXT,
  language                TEXT        NOT NULL DEFAULT 'en',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conv_messages_session ON conversation_messages(session_id);

-- ─────────────────────────────────────────────
-- 5. Conversations view
--    wa_02 reads history as (role, content) rows.
--    This view expands each conversation_messages row
--    into two rows — one user, one assistant.
-- ─────────────────────────────────────────────
CREATE OR REPLACE VIEW conversations AS
  SELECT session_id, 'user'      AS role, user_message   AS content, stage, created_at FROM conversation_messages WHERE user_message  IS NOT NULL
  UNION ALL
  SELECT session_id, 'assistant' AS role, agent_response AS content, stage, created_at FROM conversation_messages WHERE agent_response IS NOT NULL;
