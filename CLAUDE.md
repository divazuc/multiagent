# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## What This Repo Is

A modular multi-agent orchestration system built entirely in **n8n** (v1 execution order). All files are n8n workflow exports (`.json`). There is no build step, no package manager, and no runtime to start locally — workflows are imported into a running n8n instance.

---

## Workflow Inventory

| File | Purpose |
|------|---------|
| `AG_00_ENTRYPOINT_SUPERVISOR.json` | Entry point: classifies requests, routes to personas, orchestrates the pipeline |
| `AG_01–AG_10_*.json` | Specialist personas (see README for full model/token config) |
| `AG_11_PROJECT_STATE_MANAGER.json` | Persistent project state via Postgres; exposes REST endpoints called by AG_00 |
| `BIZ_WA_BUSINESS_SETUP_CHAT.json` | Separate LangChain Chat Trigger workflow for business setup (different DB credential: `Whatsapp_agent_DB`) |
| `AG_DB_PING_TEST.json` | Manual-trigger utility to verify DB connectivity (credential: `multiagent_n8n`) |
| `schema.sql` | Canonical DDL for all AG_ tables — run once in Postgres/Supabase |

---

## Architecture

### Call Pattern
Every Claude call in AG_00–AG_10 follows:
```
Code (build request body) → HTTP Request → Code (parse response)
```
No LangChain or native Anthropic nodes. All calls hit `https://api.anthropic.com/v1/messages` directly with a **Header Auth** credential named `ANTHROPIC_HTTP_HEADER_AUTH` (`x-api-key` header).

### Routing Logic in AG_00
AG_00 classifies the incoming message into a `task_type`, then fan-outs to the minimum required personas:

| task_type | Personas |
|-----------|----------|
| `discovery` | AG_01 |
| `system_design` | AG_02 → AG_03 |
| `implementation_planning` | AG_03 → AG_05 |
| `full_product_flow` | AG_01 → AG_02 → AG_03 → AG_05 |
| `default` | AG_01 → AG_02 |

AG_08 (QA) → AG_09 (DevIntel) → AG_10 (Formatter) are always appended.

### AG_10 receives only summaries
To keep Haiku calls cheap, AG_10 receives `{status, summary}` per persona — not the full structured outputs.

### AG_11 is a separate stateful service
AG_11 exposes its own webhooks (`/ag/project/*`) and is called by AG_00 via HTTP Request nodes, not via Execute Workflow. It requires the `DATABASE_CONNECTION` Postgres credential.

### BIZ_WA uses a different DB credential
`BIZ_WA_BUSINESS_SETUP_CHAT` uses `Whatsapp_agent_DB` and works against a `businesses` table (not the `ag_*` tables). It uses the n8n LangChain Chat Trigger node, not the HTTP webhook pattern used by the AG_ system.

---

## Credentials Required

| Credential Name | Type | Used By |
|----------------|------|---------|
| `ANTHROPIC_HTTP_HEADER_AUTH` | Header Auth (`x-api-key`) | AG_00–AG_10 |
| `DATABASE_CONNECTION` | Postgres | AG_11 |
| `Whatsapp_agent_DB` | Postgres | BIZ_WA |
| `multiagent_n8n` | Postgres | AG_DB_PING_TEST |

---

## Database Setup

Run `schema.sql` once in your Postgres/Supabase instance. It creates:
- `ag_projects` — one row per project
- `ag_runs` — one row per execution attempt
- `ag_step_results` — one row per persona output (stores `structured_output`, `risks`, `blocking_questions` as JSONB)
- `ag_project_logs` — audit trail

AG_11's sticky note also references an `ag_artifacts` table not in `schema.sql` — add it if needed.

---

## Import & Activation Order

1. Import AG_01–AG_10 first (in any order among themselves).
2. Import AG_00 **last** — then open each Execute Workflow node and replace the placeholder workflow ID with the real n8n workflow ID (visible in the URL: `/workflow/XXXXXXX`).
3. Import AG_11 separately; set it **Active**.
4. Set AG_00 **Active** to expose webhooks. AG_01–AG_10 do **not** need to be activated.

---

## Modifying Workflows

### Changing a model
Edit the `model` field in the **Build Request** Code node of the target workflow:
```javascript
var apiBody = {
  model: 'claude-sonnet-4-6',  // ← change this only
  max_tokens: 2048,
  ...
};
```

### Adding a new persona
1. Create the workflow following the `Code → HTTP Request → Code` pattern.
2. Import it, note its workflow ID.
3. Add an Execute Workflow node in AG_00 pointing to the new ID.
4. Update the routing logic Code node in AG_00 to include the new persona in the appropriate task type branch.

### Editing prompts
Prompts are embedded as string literals inside Code nodes in each workflow JSON. Search for `"jsCode"` keys or open the workflow in n8n and edit the Code node directly.

---

## Webhook Endpoints (AG_00)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/webhook/ag/supervisor/entry` | Main entry — all requests start here |
| POST | `/webhook/ag/supervisor/clarification-reply` | Re-submit with user answers |
| POST | `/webhook/ag/supervisor/approval` | Approve or reject a proposed plan |

Minimum payload for `/entry`:
```json
{ "message": "string (required)", "request_id": "optional", "user_id": "optional" }
```

---

## Clarification & Approval Handling

If any persona returns `status: "clarification_needed"`, its `blocking_questions` surface in the final response's `open_questions`. Re-submit to `/entry` with answers in the `context` field. Full stateful resume requires AG_11 to be running and linked.
