# Clarification Loop — Design Spec
**Date:** 2026-04-18

## Overview

Add a per-stage clarification loop to the WA_04 Setup Onboarding Flow. When Claude judges that a user's answer is genuinely unclear or incomplete for the stage's purpose, it can ask up to 3 focused follow-up questions before advancing. Every turn is saved so sessions can be resumed at any point, including mid-clarification.

---

## Global Rules

**Hard (enforced in code):**
- Max 3 clarification questions per stage. At turn 3, always advance — no exceptions.
- Clarification only triggers when `extracted_value` is empty or clearly incomplete. If Claude extracted something useful, it advances.
- On turn 3, Claude synthesizes a best-effort answer from the full stage conversation and advances.

**Soft (Claude's judgment, via prompt):**
- Ask one focused follow-up at a time — never a list.
- The bar is "enough to work with", not "perfect".
- Each clarifying question must be directly connected to the original stage purpose — no scope creep.

---

## Data Layer

### `conversation_messages` — new column
```sql
ALTER TABLE conversation_messages ADD COLUMN setup_stage TEXT;
```
Populated on every message save (user + assistant). Null for live/demo mode sessions.

### `draft_setup_data` — turn counter per stage
Stored as a flat key inside the existing JSONB draft:
```json
{ "studio_collect_classes_turns": 2 }
```
Updated on every turn (clarify and save_draft alike). Partial `extracted_value` also saved each turn.

---

## Flow

```
User sends message
  ↓
WA_00: Load setup draft
  → draft_setup_data + current_setup_stage (from sessions table)
  → stage_history: up to 20 messages WHERE setup_stage = current_setup_stage, ORDER BY created_at ASC

WA_04: Stage node (HTTP → Claude)
  → messages[] = [...stage_history, { role: "user", content: message }]
  → Claude returns: setup_response, extracted_value, action ("clarify" | "save_draft")

WA_04: Build draft setup data
  → increment draft[stage + "_turns"]
  → if turns >= 3: force action = "save_draft"
  → save partial extracted_value regardless of action
  → next_setup_stage: hardcoded map (unchanged), only applied on save_draft

WA_04: Determine save action
  → "save_draft": existing path — update setup_drafts + advance sessions.current_setup_stage
  → "clarify":    new path — update setup_drafts only, sessions.current_setup_stage unchanged

WA_06: Save conversation messages
  → save user message with setup_stage = current_setup_stage
  → save assistant message with setup_stage = current_setup_stage
  → runs on EVERY turn (clarify and save_draft)
```

---

## Resume Behaviour

On session resume at any stage mid-clarification:
1. WA_00 loads `current_setup_stage` (unchanged from last clarify turn)
2. WA_00 loads `stage_history` filtered by `setup_stage = current_setup_stage`
3. WA_04 receives full prior exchange for that stage
4. Claude continues the clarification with full context

---

## Component Changes

### 1. DB migration
- Add `setup_stage TEXT` column to `conversation_messages`

### 2. WA_00 — `Load setup draft` (Postgres query)
- Extend query to also aggregate `stage_history` from `conversation_messages` WHERE `setup_stage = current_setup_stage`
- Pass `stage_history` as array to WA_04 alongside existing fields

### 3. WA_04 — All 12 stage HTTP nodes
- `messages[]` field changes from single user message to:
  `[...stage_history, { role: "user", content: message }]`
- System prompt addition (all stages):
  > If the answer is unclear or incomplete for this stage's purpose, return `"action": "clarify"` with one focused follow-up question. If you have enough to work with, return `"action": "save_draft"`. On turn 3 (turns >= 3 in draft), always return `"action": "save_draft"` and synthesize the best answer from the full conversation.

### 4. WA_04 — `Build draft setup data` (Code node)
- Read `draft[stage + "_turns"]`, increment, write back
- If turns >= 3: override `action` to `"save_draft"`
- Always save partial `extracted_value` into draft (not only on save_draft)

### 5. WA_04 — `Determine save action` (Switch node)
- Add case for `action = "clarify"`:
  - Routes to new "Save clarify draft" Postgres node
  - Updates `setup_drafts` (draft_setup_data + turn counter)
  - Does NOT update `sessions.current_setup_stage`

### 6. WA_06 — Save Conversation
- Add `setup_stage` field to both user and assistant message inserts
- Value: `current_setup_stage` from the incoming payload

---

## Out of Scope (v1)
- Visual distinction in wa-studio between clarification turns and stage-advancing turns
- Per-stage configuration of max turns (global rule of 3 applies to all stages)
- Clarification loop for live/demo mode sessions
