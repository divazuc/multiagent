# Design: Map Step Clarification Loop

**Date:** 2026-04-15
**Scope:** `workflow-generator` — ProjectMode map step

---

## Problem

After "Analyze spec" produces a workflow map, the user has no way to address gaps Claude identified. They must go back to step 1 and rewrite the full spec, which is disruptive and loses the structured output.

---

## Goal

Let the user iteratively clarify missing information directly on the map step, without rewriting the spec. Blocking gaps prevent generation until resolved. Non-blocking gaps can be deferred and tracked as project notes.

---

## User Flow

```
Spec input → Analyze → [Map step loop] → Generate
                              │
                     ┌────────▼─────────┐
                     │  Workflow cards   │  (read-only)
                     │  Blocking gaps    │  (red — must resolve)
                     │  Non-blocking gaps│  (amber — can defer)
                     │  Clarif. textarea │
                     │  [Re-analyze]     │
                     │  Context so far ▾ │  (collapsed history)
                     │  Pending info     │  (deferred items)
                     │                  │
                     │  [Continue editing spec]  [Generate X →]
                     │   always visible   only when no blocking gaps
                     └──────────────────┘
```

1. After analysis, if gaps exist, the clarification textarea is shown.
2. User types clarifications → "Re-analyze" → updated map replaces current one.
3. Textarea clears after each submission; accumulated context is passed to the analyzer on every re-analyze call.
4. If a non-blocking gap is deferred ("will provide later"), the analyzer moves it to the Pending info list rather than keeping it as a gap.
5. "Generate X workflows" appears only when zero blocking gaps remain.
6. "Continue editing spec" re-focuses the clarification textarea for another round — it is always visible.

---

## Gap Classification

The `analyzeSpec` server response schema changes from:

```json
{ "gaps": ["string", ...] }
```

to:

```json
{
  "gaps": [
    { "question": "Which email provider?", "blocking": false },
    { "question": "What is the Supabase table name?", "blocking": true }
  ]
}
```

**Blocking** = the workflow structure cannot be correctly determined without this answer (e.g., unknown table names, missing trigger type, unclear supervisor↔sub relationship).

**Non-blocking** = generation can proceed with a reasonable placeholder or assumption (e.g., email provider, specific field names, optional integrations).

The system prompt instructs Claude to classify gaps conservatively — prefer non-blocking unless the answer materially changes the workflow graph.

---

## Accumulated Clarifications

- The client keeps an array `clarifications: string[]` in component state.
- On each "Re-analyze", the new textarea value is appended to the array.
- The full array is joined and appended to the spec before sending to `analyzeSpec`.
- A collapsed "Context added so far" section shows the history of submitted clarifications.

Server-side, `analyzeSpec` receives `{ spec, clarifications }` (clarifications is the joined string). The system prompt is updated to instruct the analyzer to treat clarifications as addenda to the spec.

---

## Deferred (Pending) Info

- When the user submits a clarification that signals deferral ("will provide later", "don't have this", etc.), the analyzer recognizes this and moves that gap to `pendingInfo[]` in the response.
- The client accumulates `pendingInfo` items across rounds into a persistent list.
- A "Pending info" panel is shown at the bottom of the map step with each deferred item and an optional inline note the user can type.
- On generate, the pending info list (including any inline notes the user typed) is sent to the server and saved as `projects/{slug}/pending-info.md` in a simple markdown checklist format.
- The pending info panel is shown read-only on the generate and import steps as a reminder.
- Deferral recognition is prompt-based: the system prompt instructs Claude that if a clarification round contains phrases like "will provide later", "don't have this", "TBD", or similar, it should move the corresponding gap to `pendingInfo[]` rather than keeping it in `gaps[]`.

The `analyzeSpec` response gains an optional `pendingInfo: string[]` field alongside `gaps`.

---

## Server Changes

### `projectAnalyzer.js` — `analyzeSpec(client, spec, clarifications?)`
- Accepts optional `clarifications` string parameter.
- System prompt updated to:
  - Classify each gap as `blocking: true/false`.
  - Emit `pendingInfo[]` for gaps where the user signalled deferral.
- Response shape:
  ```json
  {
    "projectName": "...",
    "workflows": [...],
    "gaps": [{ "question": "...", "blocking": boolean }],
    "pendingInfo": ["..."]
  }
  ```

### `routes/project.js` — `POST /project/analyze`
- Request body gains optional `clarifications: string`.
- Passed through to `analyzeSpec`.

### `routes/project.js` — `POST /project/generate`
- Request body gains optional `pendingInfo: string[]`.
- Server writes `projects/{slug}/pending-info.md` if the array is non-empty.

---

## Client Changes (`ProjectMode.jsx`)

New state:
- `clarifications: string[]` — accumulated submitted clarification rounds
- `currentClarification: string` — textarea value for current round
- `pendingInfo: string[]` — accumulated deferred items across rounds
- `pendingNotes: Record<string, string>` — user's inline notes per deferred item

Map step additions:
- Blocking gaps rendered in red panel; non-blocking in amber.
- Clarification textarea + "Re-analyze" button (visible when any gap exists or user clicks "Continue editing spec").
- Collapsed "Context added so far" section.
- Pending info panel (visible when `pendingInfo.length > 0`).
- "Generate X workflows" button gated on: `!loading && blockingGaps.length === 0`.
- "Continue editing spec" always visible on map step, focuses the textarea.

Generate/import steps:
- Pending info panel shown read-only above the action bar.

---

## What Does Not Change

- Workflow cards remain read-only — users cannot edit individual workflow fields.
- The generate, import, and download flows are unchanged.
- The spec textarea on step 1 remains unchanged.
- BuildMode, EditMode, and other tabs are unaffected.
