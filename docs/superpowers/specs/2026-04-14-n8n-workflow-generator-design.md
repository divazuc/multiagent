# n8n Workflow Generator — Design Spec

**Date:** 2026-04-14
**Status:** Approved

---

## What We're Building

A standalone web application that lets non-technical users generate and edit n8n workflow JSON files using plain language. Users describe what they want; the app produces a validated, importable `.json` file.

---

## Users

Non-technical people who know exactly what they want a workflow to do but cannot hand-write n8n JSON or navigate n8n's node system. Two situations:

1. **Building from scratch** — they have an idea and need it turned into a workflow
2. **Editing an existing workflow** — they have a working workflow and want to change it without breaking it

---

## Modes

### Build Mode

1. User types a plain-language description of the workflow
2. User selects the target n8n version (default: 1.x)
3. Clicks **Generate**
4. App returns: a plain-language summary of what was built, schema validation badge, and a download button

### Edit Mode

User loads an existing workflow via one of two methods:

- **Upload** — drag-and-drop or file picker for a `.json` export
- **Connect to n8n** — user enters their n8n base URL + API key; app fetches the workflow list via `GET /api/v1/workflows`; user selects one

The n8n version is inferred from the loaded workflow JSON (`typeVersion` fields), so no version selector is shown in Edit mode.

After loading, user types a plain-language change description and clicks **Apply changes**. Output shows a human-readable diff (added/removed nodes and connections) plus the same download and test options.

---

## Output Area (Both Modes)

After generation or edit:

- **Intent summary** — plain English description of what the workflow does (e.g. "Triggers on a webhook → sends a Slack message → logs to Google Sheets")
- **Validation badge** — schema valid / node count / n8n version
- **Download .json** — the validated workflow file
- **Test in n8n** — optional, see below
- **Refine** — re-opens the input with the current workflow as context for further iteration

---

## Pipeline

```
User input
    ↓
Backend API (Node/Express)
    ↓
LLM call — `claude-sonnet-4-6`
  System prompt: n8n node schema catalogue (all valid node types,
                 required fields, connection rules, n8n version rules)
  User message:  description [+ existing JSON if edit mode]
  Response shape: { workflow: {...}, summary: "...", nodes_used: [...] }
    ↓
Schema validation — Ajv against n8n JSON schema
  Pass → return to frontend
  Fail → send errors back to Claude, auto-retry once
         If still failing → surface human-readable errors to user
    ↓
Frontend: show summary + badges + action buttons
```

---

## Safe Test Run

Optional. User initiates by clicking **Test in n8n** and entering their n8n URL + API key.

Steps:
1. Backend imports the workflow to n8n via API as **INACTIVE** — no live webhooks fire
2. Sends a manual test trigger to the workflow
3. Reads execution result from n8n's execution log
4. Displays pass/fail and node-by-node output in plain language
5. Prompts user: **Delete test import** or **Keep it**

The n8n API key is used only for this request and never stored or logged.

---

## Tech Stack

| Layer | Choice |
|-------|--------|
| Frontend | React + Vite |
| Backend | Node.js + Express |
| LLM | Claude `claude-sonnet-4-6` via Anthropic API |
| Schema validation | Ajv (JSON Schema) |
| n8n schema catalogue | Versioned JSON file in repo, updated per n8n release |
| Styling | Tailwind CSS |
| Deployment | Express serves the React build + API routes (single server) |

---

## Security

- **Anthropic API key** — environment variable on the backend only, never sent to the frontend
- **n8n API key** — passed per-request from the frontend, used once, never stored or logged
- **Uploaded JSON** — processed in memory, never written to disk

---

## Schema Catalogue

The n8n node schema is maintained as a versioned JSON file in the repo (`src/schema/n8n-nodes-v1.json`). It contains:

- All valid node type names (`n8n-nodes-base.webhook`, `n8n-nodes-base.slack`, etc.)
- Required and optional fields per node type
- Valid connection rules (which node types can connect to which)

This file is embedded in the Claude system prompt at request time. When n8n adds new node types, this file is updated and committed.

---

## Validation Rules

Checked by Ajv after every LLM generation:

1. All nodes have a valid `type` (present in the schema catalogue)
2. All nodes have required fields (`id`, `name`, `type`, `typeVersion`, `position`, `parameters`)
3. All connection references point to existing node IDs
4. No orphaned nodes (every non-trigger node has at least one incoming connection)
5. At least one trigger node per workflow

---

## What's Out of Scope

- Visual drag-and-drop node editor
- Real-time collaboration
- Workflow version history / storage (no database — stateless)
- Credential management (credentials are placeholders in the JSON; users fill them in n8n)
- Support for n8n community nodes (schema catalogue covers official nodes only)
