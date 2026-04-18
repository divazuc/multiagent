-- WhatsApp AI Sales Agent — Production Schema v2
-- Run in Supabase SQL editor after schema.sql (adds new tables, does not drop old ones)
-- Fully idempotent: safe to re-run on fresh DB or one that already has a businesses table.
--
-- Table groups:
--   [PROD]  Production data model (blueprint-aligned, used by admin/client UI)
--   [N8N]   N8n operational tables (used directly by n8n workflows)
-- ─────────────────────────────────────────────────────────────────────────────


-- ══════════════════════════════════════════════
-- [PROD] 1. businesses
--   Core business record. One row per SMB client.
--
--   Uses CREATE TABLE IF NOT EXISTS to handle a fresh DB.
--   Followed by ALTER TABLE ADD COLUMN IF NOT EXISTS for every column
--   so that an existing businesses table (e.g. from BIZ_WA workflow)
--   is upgraded in-place without losing existing rows.
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS businesses (
  id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL
);

-- Add every column idempotently — safe whether the table is new or pre-existing
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS owner_name              TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS phone                   TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS whatsapp_number         TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS owner_notification_phone TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS archetype               TEXT
    CHECK (archetype IN ('service','professional','studio','physical_store','ecommerce','custom_quote'));
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS plan_type               TEXT NOT NULL DEFAULT 'basic';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS language                TEXT NOT NULL DEFAULT 'he';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS agent_enabled           BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS setup_completed         BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS setup_stage             TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS setup_draft             JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS training_completed      BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS guardrails              JSONB NOT NULL DEFAULT '{}';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS status                  TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','inactive'));               -- account status (not agent hours)
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS is_test                 BOOLEAN NOT NULL DEFAULT FALSE; -- test/demo business flag
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_businesses_archetype ON businesses(archetype);
CREATE INDEX IF NOT EXISTS idx_businesses_plan      ON businesses(plan_type);
CREATE INDEX IF NOT EXISTS idx_businesses_status    ON businesses(status);


-- ══════════════════════════════════════════════
-- [PROD] 2. business_config
--   Operational rules: hours, intake, pricing, booking, leads.
--   Agreed additions vs blueprint:
--     + services is jsonb (array of service objects) not plain text
--     + topics_allowed / topics_blocked for fine-grained guardrails
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS business_config (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id                 UUID        NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
  services                    JSONB       NOT NULL DEFAULT '[]',  -- [{name, description, price_hint}]
  target_audience             TEXT,
  topics_allowed              JSONB       NOT NULL DEFAULT '[]',  -- explicit allow-list
  topics_blocked              JSONB       NOT NULL DEFAULT '[]',  -- explicit block-list
  business_hours              JSONB,                              -- {mon:[open,close], ...}
  agent_active_hours          JSONB,
  agent_pause_hours           JSONB,
  availability_exceptions     JSONB,
  escalation_rules            JSONB,
  pricing_type                TEXT        CHECK (pricing_type IN ('fixed','variable','custom')),
  pricing_notes               TEXT,
  required_pricing_fields     JSONB,
  pricing_response_strategy   TEXT        CHECK (pricing_response_strategy IN ('range','ask_questions','escalate')),
  intake_required_fields      JSONB,
  intake_depth                TEXT        CHECK (intake_depth IN ('basic','detailed','dynamic')),
  stop_point                  TEXT        CHECK (stop_point IN ('after_basic','after_questions','only_if_needed')),
  has_booking                 BOOLEAN     NOT NULL DEFAULT FALSE,
  booking_method              TEXT        CHECK (booking_method IN ('manual','phone','external','none')),
  booking_strategy            TEXT        CHECK (booking_strategy IN ('collect_only','suggest','future_auto')),
  booking_required_fields     JSONB,
  booking_notes               TEXT,
  has_paid_marketing          BOOLEAN     NOT NULL DEFAULT FALSE,
  lead_sources                JSONB,
  lead_management_type        TEXT        CHECK (lead_management_type IN ('crm','sheet','none')),
  crm_name                    TEXT,
  has_marketer                BOOLEAN,
  lead_volume                 TEXT        CHECK (lead_volume IN ('low','medium','high','very_high')),
  response_time               TEXT        CHECK (response_time IN ('immediate','hours','day','inconsistent')),
  followup_behavior           TEXT        CHECK (followup_behavior IN ('always','sometimes','rarely')),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ══════════════════════════════════════════════
-- [PROD] 3. business_persona
--   Language profile used when generating replies.
--   Agreed additions vs blueprint:
--     + language_patterns  (language-specific phrasing examples, e.g. Hebrew idioms)
--     + guardrails_override (per-business override of global guardrails)
--     + tone               (formal / casual / warm)
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS business_persona (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID        NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
  opening_examples    JSONB,                   -- sample opening messages
  first_question      TEXT,                    -- how the bot opens a new conversation
  common_phrases      JSONB,                   -- frequently used phrases
  closing_style       TEXT,
  answer_length       TEXT        CHECK (answer_length IN ('short','medium','long')),
  tone                TEXT        CHECK (tone IN ('formal','casual','warm')),
  language_patterns   JSONB       NOT NULL DEFAULT '{}', -- {he: {greetings:[...], closings:[...]}}
  guardrails_override JSONB       NOT NULL DEFAULT '{}', -- overrides businesses.guardrails if set
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ══════════════════════════════════════════════
-- [PROD] 4. knowledge_items
--   Approved Q&A knowledge base for the business.
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS knowledge_items (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  category    TEXT,
  question    TEXT        NOT NULL,
  answer      TEXT        NOT NULL,
  language    TEXT        NOT NULL DEFAULT 'he',
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_business ON knowledge_items(business_id, is_active);


-- ══════════════════════════════════════════════
-- [PROD] 5. contacts
--   Lead / contact records per business.
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS contacts (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  phone               TEXT        NOT NULL,
  name                TEXT,
  source              TEXT        CHECK (source IN ('whatsapp','form','import','api')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_interaction_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_business_phone ON contacts(business_id, phone);


-- ══════════════════════════════════════════════
-- [PROD] 6. prod_conversations
--   Conversation thread per business+contact.
--   Named prod_conversations to avoid clashing with the existing n8n view.
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS prod_conversations (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID    NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  contact_id   UUID    NOT NULL REFERENCES contacts(id)   ON DELETE CASCADE,
  status       TEXT    NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','waiting_owner','closed')),
  is_escalated BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prod_conv_business ON prod_conversations(business_id, status);
CREATE INDEX IF NOT EXISTS idx_prod_conv_contact  ON prod_conversations(contact_id);


-- ══════════════════════════════════════════════
-- [PROD] 7. prod_messages
--   Individual messages inside a prod_conversations thread.
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS prod_messages (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID    NOT NULL REFERENCES prod_conversations(id) ON DELETE CASCADE,
  direction       TEXT    CHECK (direction IN ('inbound','outbound')),
  sender_type     TEXT    CHECK (sender_type IN ('user','assistant','owner')),
  message_text    TEXT,
  meta_message_id TEXT,                -- WhatsApp message ID from Meta API
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prod_messages_conv ON prod_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_prod_messages_meta ON prod_messages(meta_message_id);


-- ══════════════════════════════════════════════
-- [PROD] 8. business_usage_daily
--   Pre-aggregated daily counters (upsert daily by cron/trigger).
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS business_usage_daily (
  id                      UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id             UUID    NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  usage_date              DATE    NOT NULL,
  lead_count              INTEGER NOT NULL DEFAULT 0,
  conversation_count      INTEGER NOT NULL DEFAULT 0,
  inbound_message_count   INTEGER NOT NULL DEFAULT 0,
  outbound_message_count  INTEGER NOT NULL DEFAULT 0,
  agent_reply_count       INTEGER NOT NULL DEFAULT 0,
  escalation_count        INTEGER NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_daily_biz_date ON business_usage_daily(business_id, usage_date);


-- ══════════════════════════════════════════════
-- [PROD] 9. business_usage_monthly
--   Pre-aggregated monthly counters.
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS business_usage_monthly (
  id                      UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id             UUID    NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  usage_month             DATE    NOT NULL, -- first day of the month
  lead_count              INTEGER NOT NULL DEFAULT 0,
  conversation_count      INTEGER NOT NULL DEFAULT 0,
  inbound_message_count   INTEGER NOT NULL DEFAULT 0,
  outbound_message_count  INTEGER NOT NULL DEFAULT 0,
  agent_reply_count       INTEGER NOT NULL DEFAULT 0,
  escalation_count        INTEGER NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_monthly_biz_month ON business_usage_monthly(business_id, usage_month);


-- ══════════════════════════════════════════════
-- [PROD] 10. external_leads_sources
--   Pro plan: Google Sheets / CRM connections.
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS external_leads_sources (
  id                UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID    NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  source_type       TEXT    CHECK (source_type IN ('google_sheet','crm')),
  connection_config JSONB,
  is_active         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ══════════════════════════════════════════════
-- [PROD] 11. admin_sessions
--   Admin onboarding/setup chat state (replaces blueprint's chat_sessions).
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS admin_sessions (
  id                    UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key           TEXT    NOT NULL UNIQUE,
  current_mode          TEXT,
  selected_business_id  UUID    REFERENCES businesses(id),
  pending_business_name TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ══════════════════════════════════════════════
-- [N8N] Existing operational tables — kept for workflow compatibility
--   sessions            (WA_02 load session, WA_07 save state)
--   setup_drafts        (WA_00 load draft, WA_04 progressive saves)
--   business_profiles   (WA_07 committed profile)
--   conversation_messages + conversations view (WA_06 message log, WA_02 history)
--
--   These are defined in schema.sql. Do not redefine here.
--   Future work: migrate WA_02/WA_06/WA_07 to write into the PROD tables above,
--   then drop the n8n operational tables.
-- ══════════════════════════════════════════════


-- ══════════════════════════════════════════════
-- Triggers: keep updated_at current
-- ══════════════════════════════════════════════
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

-- Only attach updated_at triggers to tables that actually have that column.
-- prod_messages intentionally omitted (insert-only, no updated_at).
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'businesses','business_config','business_persona','knowledge_items',
    'prod_conversations',
    'business_usage_daily','business_usage_monthly',
    'external_leads_sources','admin_sessions'
  ] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%I_updated ON %I;
       CREATE TRIGGER trg_%I_updated BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION set_updated_at();',
      t, t, t, t
    );
  END LOOP;
END;
$$;
