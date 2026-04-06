-- AG11 Project State Manager — Required DB Tables
-- Run once in your Postgres / Supabase SQL editor

-- ─────────────────────────────────────────────
-- 1. Projects
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ag_projects (
  project_id          TEXT        PRIMARY KEY,
  title               TEXT,
  status              TEXT        NOT NULL DEFAULT 'active',
  current_step        TEXT,
  last_completed_step TEXT,
  last_summary        TEXT,
  next_action         TEXT        NOT NULL DEFAULT 'start',
  latest_run_id       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- 2. Runs  (one row per execution attempt)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ag_runs (
  run_id              TEXT        PRIMARY KEY,
  project_id          TEXT        NOT NULL REFERENCES ag_projects(project_id),
  status              TEXT        NOT NULL DEFAULT 'processing',
  current_step        TEXT,
  last_completed_step TEXT,
  next_action         TEXT,
  error               TEXT,
  retry_count         INTEGER     NOT NULL DEFAULT 0,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ag_runs_project_id ON ag_runs(project_id);

-- ─────────────────────────────────────────────
-- 3. Step Results  (one row per persona output)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ag_step_results (
  step_result_id      TEXT        PRIMARY KEY,
  run_id              TEXT        NOT NULL REFERENCES ag_runs(run_id),
  project_id          TEXT        NOT NULL,
  step_name           TEXT        NOT NULL,
  status              TEXT        NOT NULL DEFAULT 'success',
  summary             TEXT,
  structured_output   JSONB,
  risks               JSONB,
  assumptions         JSONB,
  blocking_questions  JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ag_step_results_run_id     ON ag_step_results(run_id);
CREATE INDEX IF NOT EXISTS idx_ag_step_results_project_id ON ag_step_results(project_id);

-- ─────────────────────────────────────────────
-- 4. Project Logs  (audit trail for all events)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ag_project_logs (
  log_id      TEXT        PRIMARY KEY,
  project_id  TEXT        NOT NULL,
  run_id      TEXT,
  event_type  TEXT        NOT NULL,
  step_name   TEXT,
  message     TEXT,
  payload     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ag_project_logs_project_id ON ag_project_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_ag_project_logs_run_id     ON ag_project_logs(run_id);
