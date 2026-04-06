# AG_ Multi-Agent Orchestration System
### Production-Grade Modular AI Workflow for n8n — HTTP API Edition

---

## System Overview

Modular AI multi-agent orchestration in n8n. A Supervisor classifies requests, routes them to the minimal required specialist personas, and returns a structured final response.

**All Anthropic calls are made via HTTP Request nodes** pointing directly to `https://api.anthropic.com/v1/messages`. No LangChain or native Anthropic credential nodes are used.

---

## Architecture Change: HTTP Request Nodes

Instead of using n8n's native Anthropic integration, every Claude call uses:

```
Code (build request body) → HTTP Request → Code (parse response)
```

**Why:** More portable, credential-agnostic, and not dependent on n8n's LangChain node version compatibility.

### Request format (Anthropic Messages API)

```json
POST https://api.anthropic.com/v1/messages

Headers:
  x-api-key: <from credential>
  anthropic-version: 2023-06-01
  content-type: application/json

Body:
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 2048,
  "messages": [{ "role": "user", "content": "<prompt>" }]
}
```

### Response parsing

The response from Anthropic is:
```json
{
  "content": [{ "type": "text", "text": "{ ...json output... }" }]
}
```

Each workflow extracts `content[0].text`, parses the embedded JSON, and returns the standard persona output contract.

---

## Credential Setup (REQUIRED — do this first)

### Create the credential in n8n

1. Go to **n8n → Settings → Credentials → New**
2. Select type: **Header Auth**
3. Set:
   - **Name:** `ANTHROPIC_HTTP_HEADER_AUTH`
   - **Header Name:** `x-api-key`
   - **Header Value:** your Anthropic API key
4. Save

This single credential is referenced by all 11 workflows. To rotate your API key, update it here only.

### Additional static headers (pre-configured in each HTTP node)

These are hardcoded in each HTTP Request node and do not need manual setup:
- `anthropic-version: 2023-06-01`
- `content-type: application/json`

### After import: link the credential

For each workflow (AG_00 through AG_10):
1. Open the workflow
2. Click the **HTTP Request - Anthropic** node (or **HTTP Request - Classify Task** in AG_00)
3. Under **Credential**, select `ANTHROPIC_HTTP_HEADER_AUTH`
4. Save

---

## Workflow List

| File | Role | Model | Max Tokens |
|------|------|-------|-----------|
| `AG_00_ENTRYPOINT_SUPERVISOR.json` | Entry, classify, route, orchestrate | claude-sonnet-4-6 | 256 |
| `AG_01_PRODUCT_DISCOVERY.json` | Problem, users, goals, MVP | claude-sonnet-4-6 | 2048 |
| `AG_02_SOLUTION_ARCHITECT.json` | Architecture, integrations, tradeoffs | claude-opus-4-6 | 4096 |
| `AG_03_TECH_LEAD.json` | Modules, contracts, data models, build order | claude-sonnet-4-6 | 3000 |
| `AG_04_UX_UI_PLANNER.json` | User flows, screens, UX risks | claude-sonnet-4-6 | 2048 |
| `AG_05_DELIVERY_PLANNER.json` | Backlog, milestones, blockers | claude-haiku-4-5 | 2048 |
| `AG_06_FRONTEND_ENGINEER.json` | Components, routing, state, edge cases | claude-sonnet-4-6 | 3000 |
| `AG_07_BACKEND_ENGINEER.json` | APIs, DB schema, business logic | claude-sonnet-4-6 | 3000 |
| `AG_08_QA_REVIEWER.json` | Readiness verdict, issues, test cases | claude-sonnet-4-6 | 2048 |
| `AG_09_DEV_INTELLIGENCE.json` | Execution metrics, bottlenecks, git summary | claude-haiku-4-5 | 1024 |
| `AG_10_RESPONSE_FORMATTER.json` | Final user-facing response | claude-haiku-4-5 | 1024 |

---

## Model Selection

| Tier | Model ID | Used For |
|------|----------|----------|
| Haiku | `claude-haiku-4-5-20251001` | Structured formatting, metric aggregation, simple JSON synthesis (AG_05, AG_09, AG_10) |
| Sonnet | `claude-sonnet-4-6` | Balanced reasoning — technical planning, UX design, QA, engineering (default) |
| Opus | `claude-opus-4-6` | Deep reasoning — complex multi-service architecture (AG_02 only by default) |

### How to change a model

The model is set in the **Build Request** Code node of each workflow:

```javascript
var apiBody = {
  model: 'claude-sonnet-4-6',  // ← change this
  max_tokens: 2048,
  messages: [...]
};
```

Change only the `model` field. The credential and headers are on the HTTP Request node and do not need updating when changing models.

### Opus escalation

Opus is assigned only to AG_02 by default. You may escalate other workflows to Opus when:
- Complex multi-service architecture with conflicting constraints
- Critical QA failure analysis requiring deep cross-persona reasoning
- Major refactor planning

Do not auto-escalate. Change only when there is a clear reasoning requirement.

---

## Import Order

Import in this exact order so AG_00 can reference the correct workflow IDs:

1. `AG_01_PRODUCT_DISCOVERY.json`
2. `AG_02_SOLUTION_ARCHITECT.json`
3. `AG_03_TECH_LEAD.json`
4. `AG_04_UX_UI_PLANNER.json`
5. `AG_05_DELIVERY_PLANNER.json`
6. `AG_06_FRONTEND_ENGINEER.json`
7. `AG_07_BACKEND_ENGINEER.json`
8. `AG_08_QA_REVIEWER.json`
9. `AG_09_DEV_INTELLIGENCE.json`
10. `AG_10_RESPONSE_FORMATTER.json`
11. `AG_00_ENTRYPOINT_SUPERVISOR.json` **(last)**

---

## Post-Import Manual Steps

### Step 1 — Create `ANTHROPIC_HTTP_HEADER_AUTH` credential
See Credential Setup section above.

### Step 2 — Link credential in each workflow
Open each workflow → open the HTTP Request node → select `ANTHROPIC_HTTP_HEADER_AUTH`.

### Step 3 — Update Execute Workflow IDs in AG_00
Open `AG_00_ENTRYPOINT_SUPERVISOR`. For each `Execute Workflow` node, replace the placeholder ID with the actual n8n workflow ID (found in the URL bar when the workflow is open: `/workflow/XXXXXXX`).

| Node Name | Target Workflow |
|-----------|----------------|
| Execute AG_01 (Discovery) | AG_01_PRODUCT_DISCOVERY |
| Execute AG_02 (SD) | AG_02_SOLUTION_ARCHITECT |
| Execute AG_03 (SD) | AG_03_TECH_LEAD |
| Execute AG_03 (Impl) | AG_03_TECH_LEAD |
| Execute AG_05 (Impl) | AG_05_DELIVERY_PLANNER |
| Execute AG_01 (FPF) | AG_01_PRODUCT_DISCOVERY |
| Execute AG_02 (FPF) | AG_02_SOLUTION_ARCHITECT |
| Execute AG_03 (FPF) | AG_03_TECH_LEAD |
| Execute AG_05 (FPF) | AG_05_DELIVERY_PLANNER |
| Execute AG_01 (Default) | AG_01_PRODUCT_DISCOVERY |
| Execute AG_02 (Default) | AG_02_SOLUTION_ARCHITECT |
| Execute AG_08 (QA) | AG_08_QA_REVIEWER |
| Execute AG_09 (DevIntel) | AG_09_DEV_INTELLIGENCE |
| Execute AG_10 (Formatter) | AG_10_RESPONSE_FORMATTER |

### Step 4 — Activate AG_00
Toggle `AG_00_ENTRYPOINT_SUPERVISOR` to **Active** to expose webhooks. Persona workflows (AG_01–AG_10) do not need to be activated.

---

## Webhook Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/webhook/ag/supervisor/entry` | Main entry for all requests |
| `POST` | `/webhook/ag/supervisor/clarification-reply` | Submit user clarification |
| `POST` | `/webhook/ag/supervisor/approval` | Submit user approval/rejection |

---

## Input / Output

### Webhook Input

```json
{
  "request_id": "string (optional)",
  "user_id":    "string (optional)",
  "message":    "string (REQUIRED)",
  "context":    {},
  "preferences": {}
}
```

### Final Response (from AG_10)

```json
{
  "persona_name": "AG_10_RESPONSE_FORMATTER",
  "status": "success|failed",
  "structured_output": {
    "executive_summary": "2-3 sentences",
    "key_findings": [{"area":"", "finding":"", "priority":"critical|high|medium|low"}],
    "next_steps":   [{"step":1, "action":"", "owner":""}],
    "open_questions": [],
    "risks": [],
    "confidence": "high|medium|low",
    "metadata": {"request_id":"", "task_type":"", "personas_run": 5}
  }
}
```

---

## Routing Logic

| Task Type | Personas Invoked |
|-----------|----------------|
| `discovery` | AG_01 |
| `system_design` | AG_02 → AG_03 |
| `implementation_planning` | AG_03 → AG_05 |
| `full_product_flow` | AG_01 → AG_02 → AG_03 → AG_05 |
| `default` | AG_01 → AG_02 |

**Always appended:** AG_08 → AG_09 → AG_10

---

## Clarification & Approval Flows

**Clarification:** If a persona returns `status: "clarification_needed"`, the final response surfaces its `blocking_questions` in `open_questions`. Re-submit to `/entry` with answers in the `context` field.

**Approval:** POST to `/webhook/ag/supervisor/approval` with `{"request_id":"...", "approved":true}`.

Both flows require a database for full stateful resume. The webhooks acknowledge receipt; add a DB node to persist and replay context.

---

## Cost Optimization

| Technique | Implementation |
|-----------|----------------|
| Haiku for formatters | AG_05, AG_09, AG_10 use Haiku — ~10× cheaper than Opus |
| Token caps | Per-workflow `max_tokens` limits (256–4096) |
| Compact prompts | Directive-only prompts, no narrative prose |
| Minimal payload | AG_10 receives only `{status, summary}` per persona, not full outputs |
| Selective routing | Supervisor invokes only personas required for the task type |

---

## File Structure

```
Multi agent/
├── AG_00_ENTRYPOINT_SUPERVISOR.json
├── AG_01_PRODUCT_DISCOVERY.json
├── AG_02_SOLUTION_ARCHITECT.json
├── AG_03_TECH_LEAD.json
├── AG_04_UX_UI_PLANNER.json
├── AG_05_DELIVERY_PLANNER.json
├── AG_06_FRONTEND_ENGINEER.json
├── AG_07_BACKEND_ENGINEER.json
├── AG_08_QA_REVIEWER.json
├── AG_09_DEV_INTELLIGENCE.json
├── AG_10_RESPONSE_FORMATTER.json
└── README.md
```

---

## Version

- n8n target: 1.x (v1 execution order)
- API: Anthropic Messages API (`anthropic-version: 2023-06-01`)
- Schema version: 3.0 — HTTP API edition
