-- FAQ archetype tagging — adds archetypes TEXT[] column + GIN index.
-- Idempotent: safe to re-run.
-- Spec: wa-studio/docs/superpowers/specs/2026-04-20-faq-archetype-tagging-design.md
-- Run in Supabase Dashboard → SQL Editor (service role required for DDL).

ALTER TABLE knowledge_items
  ADD COLUMN IF NOT EXISTS archetypes TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS knowledge_items_archetypes_idx
  ON knowledge_items USING GIN (archetypes);
