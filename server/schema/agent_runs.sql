-- Agent-native execution log — replaces n8n's built-in run history
-- One row per inbound WhatsApp message processed.
-- Each pipeline step appends to the `steps` JSONB array via the logger.
-- Safe to run multiple times (fully idempotent).

CREATE TABLE IF NOT EXISTS agent_runs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       TEXT        NOT NULL,                          -- WhatsApp wa_id / session_id
  business_id      UUID        REFERENCES businesses(id),         -- null for brand-new sessions
  inbound_message  TEXT        NOT NULL,
  session_mode     TEXT        CHECK (session_mode IN ('setup','learning','live')),
  status           TEXT        NOT NULL DEFAULT 'running'
                     CHECK (status IN ('running','success','error')),
  steps            JSONB       NOT NULL DEFAULT '[]',             -- [{step, status, duration_ms, input, output, error, ts}]
  final_response   TEXT,                                          -- the message sent back to the user
  error            TEXT,                                          -- top-level error if status='error'
  total_duration_ms INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_session    ON agent_runs(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_business   ON agent_runs(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status     ON agent_runs(status);
CREATE INDEX IF NOT EXISTS idx_agent_runs_created_at ON agent_runs(created_at DESC);

-- Atomic step append — avoids read-modify-write race when steps arrive quickly.
CREATE OR REPLACE FUNCTION append_agent_run_step(run_id UUID, step JSONB)
RETURNS VOID LANGUAGE sql AS $$
  UPDATE agent_runs
  SET steps = steps || step::jsonb
  WHERE id = run_id;
$$;
