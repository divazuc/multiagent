# Global Workflow Guidelines

These rules apply to every project. Project-specific guidelines in `projects/{slug}/guidelines.md` override these where they conflict.

---

## Naming Conventions

- Workflow names: `Title Case`, descriptive, no abbreviations (e.g. "Customer Onboarding Supervisor")
- Sub-workflow names: prefix with the project name (e.g. "Customer Onboarding — Send Welcome Email")
- Node names: verb + noun, sentence case (e.g. "Fetch user record", "Send Slack alert")
- Avoid generic names like "HTTP Request 1" or "Code 2"

---

## Supervisor Pattern

Every project with multiple workflows follows this structure:

- One **Supervisor** workflow — triggered externally (webhook/schedule/manual), calls all sub-workflows, collects results, returns a single final output
- One or more **Sub-workflows** — each does one job, always returns this shape:
  ```json
  { "status": "success|error", "result": {}, "error": null }
  ```
- Supervisor merges all sub results and responds with a structured summary

---

## Sub-workflow Input/Output Contract

Every sub-workflow:
- Receives input via the workflow's input fields (not webhook)
- Returns exactly: `{ status, result, error }`
- Never calls other sub-workflows directly — only the supervisor orchestrates

---

## Node Positioning

- Trigger node: `[100, 300]`
- Left-to-right flow: increment x by `300` per step
- Parallel branches: spread vertically by `200` per branch
- Keep the canvas readable — no overlapping nodes

---

## Credentials

- Always use placeholder credential objects: `{ "id": "CREDENTIAL_ID", "name": "Descriptive Name" }` — use the exact credential name from credential-map.md for the service being used
- Never hardcode API keys or tokens in node parameters
- See `credential-map.md` for the credential names used in this environment

---

## Code Nodes

- Use Code nodes (JavaScript) for data transformation only — no API calls inside Code nodes
- Keep Code nodes under 30 lines
- Always return an array: `return [{ json: { ... } }]`

---

## Error Handling

- Set `continueOnFail: true` only on nodes where failure is expected and handled downstream
- HTTP Request nodes that call external APIs should have `continueOnFail: true`
- Always check for errors in the node after a fallible step

---

## General

- `active: false` on all generated workflows — user activates manually
- `settings.executionOrder: "v1"` on all workflows
- Sticky notes are welcome for complex logic — add them to explain non-obvious flows
