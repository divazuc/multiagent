# Clarification Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-stage clarification loop to WA_04 so Claude can ask up to 3 follow-up questions when an answer is unclear, with full conversation history passed on every call and complete state saved after every turn for resumable sessions.

**Architecture:** Each setup stage node receives `stage_history` (previous exchanges for that stage, tagged in `conversation_messages.setup_stage`) and builds a proper multi-turn messages array for Claude. Claude returns `action: "clarify"` or `action: "save_draft"`. A turn counter in `draft_setup_data` enforces the hard cap of 3 — at turn 3 the Code node forces `save_draft` regardless. The `clarify` path saves draft state but keeps `next_setup_stage = current_stage` so WA_00 does not advance.

**Tech Stack:** n8n v1 (HTTP MCP `mcp__n8n-mcp__n8n_update_partial_workflow`), Supabase/Postgres (REST API), existing workflows WA_00 (`04FOFdVyLI7S4TBu`), WA_04 (`cLn5Z4D5siEgPvR7`), WA_06 (`4E2tMweG8tsjHtTW`)

---

## File Map

| Workflow / Resource | What changes |
|---|---|
| `conversation_messages` (Supabase table) | Add `setup_stage TEXT` column |
| WA_00 `04FOFdVyLI7S4TBu` | (1) New Postgres node saves conversation after setup exchange; (2) `Load setup draft` SQL adds `stage_history`; (3) `Prepare setup inputs` passes `stage_history` |
| WA_04 `cLn5Z4D5siEgPvR7` | (4) `Build draft setup data` — turn counter + force-advance; (5) `Determine save action` — new `clarify` case; (6) All 12 stage HTTP nodes — messages array + clarify instructions |

---

## Task 1: DB Migration — add `setup_stage` to `conversation_messages`

**Files:** Supabase DB (via curl REST)

- [ ] **Step 1.1: Run migration**

```bash
curl -s -X POST "https://mlbtqspcgdprmbytcsyc.supabase.co/rest/v1/rpc/exec_sql" \
  -H "apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1sYnRxc3BjZ2Rwcm1ieXRjc3ljIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzIzMDM2MiwiZXhwIjoyMDg4ODA2MzYyfQ.zQAgtH29Zdh1I4u_8p6ZzhLxVVY9-RTf6iNAfD4-ZPI" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1sYnRxc3BjZ2Rwcm1ieXRjc3ljIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzIzMDM2MiwiZXhwIjoyMDg4ODA2MzYyfQ.zQAgtH29Zdh1I4u_8p6ZzhLxVVY9-RTf6iNAfD4-ZPI" \
  -H "Content-Type: application/json" \
  -d '{"query": "ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS setup_stage TEXT;"}'
```

If the `exec_sql` RPC is not available, run directly via Supabase SQL editor: `ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS setup_stage TEXT;`

- [ ] **Step 1.2: Verify column exists**

```bash
curl -s "https://mlbtqspcgdprmbytcsyc.supabase.co/rest/v1/conversation_messages?limit=1" \
  -H "apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1sYnRxc3BjZ2Rwcm1ieXRjc3ljIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzIzMDM2MiwiZXhwIjoyMDg4ODA2MzYyfQ.zQAgtH29Zdh1I4u_8p6ZzhLxVVY9-RTf6iNAfD4-ZPI" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1sYnRxc3BjZ2Rwcm1ieXRjc3ljIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzIzMDM2MiwiZXhwIjoyMDg4ODA2MzYyfQ.zQAgtH29Zdh1I4u_8p6ZzhLxVVY9-RTf6iNAfD4-ZPI"
```

Expected: response includes `setup_stage` key in the row (or null for existing rows).

---

## Task 2: WA_00 — Save conversation after every setup exchange

**Context:** WA_00 currently never writes to `conversation_messages` for setup sessions. Without this, stage_history will always be empty. The message save runs after `Prepare setup state inputs` (which has the processed result from WA_04).

User message is at: `$('Check normalize status').item.json.result.message`  
Agent response is at: `$('Run setup onboarding flow').first().json.result.setup_response`  
Stage (at time of exchange): `$('Prepare setup inputs').item.json.current_setup_stage`

- [ ] **Step 2.1: Add "Save setup conversation" Postgres node to WA_00**

```javascript
// mcp__n8n-mcp__n8n_update_partial_workflow — WA_00 id: 04FOFdVyLI7S4TBu
{
  "type": "addNode",
  "node": {
    "name": "Save setup conversation",
    "type": "n8n-nodes-base.postgres",
    "typeVersion": 2.5,
    "position": [2200, 700],
    "parameters": {
      "operation": "executeQuery",
      "query": "INSERT INTO conversation_messages (session_id, business_id, user_message, agent_response, stage, setup_stage, action, created_at) VALUES ('{{ $('Check normalize status').item.json.result.session_id }}', '{{ $('Check session status').item.json.result.business_id }}', '{{ ($('Check normalize status').item.json.result.message || '').replace(/'/g, \"''\") }}', '{{ ($('Run setup onboarding flow').first().json.result.setup_response || '').replace(/'/g, \"''\") }}', '{{ $('Prepare setup inputs').item.json.current_setup_stage }}', '{{ $('Prepare setup inputs').item.json.current_setup_stage }}', '{{ $json.action || 'save_draft' }}', NOW()) ON CONFLICT DO NOTHING;",
      "options": {}
    },
    "credentials": {
      "postgres": { "id": "O6dnMJBEHEOipCdX", "name": "Whatsapp_agent_DB" }
    },
    "continueOnFail": true
  }
}
```

- [ ] **Step 2.2: Wire it — connect `Prepare setup state inputs` → `Save setup conversation`**

```javascript
{ "type": "addConnection", "source": "Prepare setup state inputs", "target": "Save setup conversation", "sourceIndex": 0, "targetIndex": 0 }
```

- [ ] **Step 2.3: Wire `Save setup conversation` → `Save setup state`**

```javascript
{ "type": "addConnection", "source": "Save setup conversation", "target": "Save setup state", "sourceIndex": 0, "targetIndex": 0 }
```

Then remove the old direct connection from `Prepare setup state inputs` → `Save setup state`:

```javascript
{ "type": "removeConnection", "source": "Prepare setup state inputs", "target": "Save setup state", "sourceIndex": 0, "targetIndex": 0 }
```

- [ ] **Step 2.4: Verify by running a test message in wa-studio**

After sending a message, check:
```bash
curl -s "https://mlbtqspcgdprmbytcsyc.supabase.co/rest/v1/conversation_messages?order=created_at.desc&limit=3&select=session_id,user_message,setup_stage,created_at" \
  -H "apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1sYnRxc3BjZ2Rwcm1ieXRjc3ljIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzIzMDM2MiwiZXhwIjoyMDg4ODA2MzYyfQ.zQAgtH29Zdh1I4u_8p6ZzhLxVVY9-RTf6iNAfD4-ZPI" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1sYnRxc3BjZ2Rwcm1ieXRjc3ljIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzIzMDM2MiwiZXhwIjoyMDg4ODA2MzYyfQ.zQAgtH29Zdh1I4u_8p6ZzhLxVVY9-RTf6iNAfD4-ZPI"
```

Expected: new row with `setup_stage` matching the current setup stage (e.g. `studio_collect_pricing`).

---

## Task 3: WA_00 — Update `Load setup draft` SQL to include `stage_history`

**Context:** The query currently returns `draft_setup_data` and `current_setup_stage`. Add `stage_history` — an ordered array of `{role, content}` objects for the current stage, suitable for passing directly to Claude's `messages[]` array.

- [ ] **Step 3.1: Patch the query**

```javascript
// patchNodeField on WA_00, node: "Load setup draft", fieldPath: "parameters.query"
// find:
"SELECT COALESCE(d.draft_setup_data, '{}'::jsonb) AS draft_setup_data, COALESCE(s.current_setup_stage, '') AS current_setup_stage FROM (SELECT 1) t LEFT JOIN setup_drafts d ON d.session_id = '{{ $('Check normalize status').item.json.result.session_id }}' LEFT JOIN sessions s ON s.session_id = '{{ $('Check normalize status').item.json.result.session_id }}' LIMIT 1;"
// replace:
"SELECT COALESCE(d.draft_setup_data, '{}'::jsonb) AS draft_setup_data, COALESCE(s.current_setup_stage, '') AS current_setup_stage, COALESCE((SELECT json_agg(msg ORDER BY ts ASC, ord ASC) FROM (SELECT json_build_object('role', 'user', 'content', user_message) AS msg, created_at AS ts, 1 AS ord FROM conversation_messages WHERE session_id = '{{ $('Check normalize status').item.json.result.session_id }}' AND setup_stage = s.current_setup_stage UNION ALL SELECT json_build_object('role', 'assistant', 'content', agent_response) AS msg, created_at AS ts, 2 AS ord FROM conversation_messages WHERE session_id = '{{ $('Check normalize status').item.json.result.session_id }}' AND setup_stage = s.current_setup_stage) expanded LIMIT 20), '[]'::json) AS stage_history FROM (SELECT 1) t LEFT JOIN setup_drafts d ON d.session_id = '{{ $('Check normalize status').item.json.result.session_id }}' LEFT JOIN sessions s ON s.session_id = '{{ $('Check normalize status').item.json.result.session_id }}' LIMIT 1;"
```

- [ ] **Step 3.2: Verify by checking execution output**

Run a test message and inspect `Load setup draft` node output in n8n. Expected: output includes `stage_history: []` for a new session (no prior messages) or `stage_history: [{role:"user",...},{role:"assistant",...}]` after at least one exchange.

---

## Task 4: WA_00 — Pass `stage_history` through `Prepare setup inputs`

**Context:** `Prepare setup inputs` is the Code node that builds the data object sent to WA_04. It currently drops `stage_history`. Add it.

- [ ] **Step 4.1: Patch the Code node**

```javascript
// patchNodeField on WA_00, node: "Prepare setup inputs", fieldPath: "parameters.jsCode"
// find:
"return [{ json: {\n  message: norm.message || '',\n  session_id: norm.session_id || '',\n  business_id: ctx.business_id || null,\n  current_setup_stage: setupStage,\n  draft_setup_data: draftData\n}}];"
// replace:
"let stageHistory = [];\ntry {\n  const raw = draftRaw.stage_history;\n  stageHistory = Array.isArray(raw) ? raw : (typeof raw === 'string' ? JSON.parse(raw) : []);\n} catch(e) {}\n\nreturn [{ json: {\n  message: norm.message || '',\n  session_id: norm.session_id || '',\n  business_id: ctx.business_id || null,\n  current_setup_stage: setupStage,\n  draft_setup_data: draftData,\n  stage_history: stageHistory\n}}];"
```

- [ ] **Step 4.2: Verify**

Run a test message. In n8n, check `Prepare setup inputs` output — should include `stage_history` (empty array on first turn, populated on subsequent turns).

---

## Task 5: WA_04 — Update `Build draft setup data` for turn counting and clarify routing

**Context:** Add turn counter per stage. Increment on every call. At turn 3, force `action = "save_draft"`. For `clarify` action, set `next_setup_stage = current_stage` so WA_00 does not advance. For `save_draft` / `commit`, use the existing hardcoded transition map.

- [ ] **Step 5.1: Patch `Build draft setup data` jsCode**

Replace the full `jsCode` with:

```javascript
const inputs = $('Extract setup inputs').item.json;
const apiResponse = $input.first().json;

let aiText = '';
if (Array.isArray(apiResponse.content)) {
  aiText = apiResponse.content[0]?.text || '';
} else if (typeof apiResponse.text === 'string') {
  aiText = apiResponse.text;
}

let aiJson = {};
try {
  const cleaned = aiText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  aiJson = JSON.parse(cleaned);
} catch(e) {
  const match = aiText.match(/\{[\s\S]*\}/);
  if (match) { try { aiJson = JSON.parse(match[0]); } catch(e2) {} }
}

const currentDraft = { ...(inputs.draft_setup_data || {}) };
const stage = inputs.current_setup_stage || 'collect_business_model';

// Turn counter — increment every call
const turnsKey = stage + '_turns';
const currentTurns = (currentDraft[turnsKey] || 0) + 1;
currentDraft[turnsKey] = currentTurns;

// Save extracted value under the stage key (always, even on clarify)
if (aiJson.extracted_value !== undefined && aiJson.extracted_value !== null) {
  currentDraft[stage] = aiJson.extracted_value;
  if (stage === 'collect_business_model' && typeof aiJson.extracted_value === 'string'
      && aiJson.extracted_value !== 'null' && aiJson.extracted_value !== 'list_shown') {
    currentDraft.archetype = aiJson.extracted_value;
  }
}

if (aiJson.extracted_guardrails) {
  currentDraft.guardrails = aiJson.extracted_guardrails;
}

// Determine action — force save_draft at turn 3
let action = aiJson.action || 'save_draft';
if (currentTurns >= 3 && action === 'clarify') {
  action = 'save_draft';
}

// Hardcoded stage transition map — only applied when advancing (not clarify)
const NEXT_STAGE = {
  'service_collect_offerings': 'service_collect_target',
  'service_collect_target': 'service_collect_urgency',
  'service_collect_urgency': 'collect_sales_goal',
  'studio_collect_classes': 'studio_collect_pricing',
  'studio_collect_pricing': 'studio_collect_booking',
  'studio_collect_booking': 'collect_sales_goal',
  'generic_collect_services': 'collect_sales_goal',
  'collect_sales_goal': 'collect_persona',
  'collect_persona': 'collect_guardrails',
  'collect_guardrails': 'confirm_and_commit',
};
const ARCHETYPE_FIRST = {
  'studio': 'studio_collect_classes',
  'service': 'service_collect_offerings',
  'other': 'generic_collect_services',
};

let nextStage = stage; // default: stay (clarify or unknown)
if (action !== 'clarify') {
  if (stage === 'collect_business_model') {
    const arch = currentDraft.archetype;
    nextStage = ARCHETYPE_FIRST[arch] || aiJson.next_setup_stage || stage;
  } else if (stage === 'confirm_and_commit') {
    nextStage = stage;
  } else {
    nextStage = NEXT_STAGE[stage] || stage;
  }
}

const isCommit = action === 'commit';

return [{ json: {
  session_id: inputs.session_id || '',
  business_id: inputs.business_id || null,
  current_setup_stage: stage,
  next_setup_stage: nextStage,
  setup_response: aiJson.setup_response || '',
  action: action,
  setup_completed: isCommit,
  draft_setup_data: currentDraft
} }];
```

- [ ] **Step 5.2: Verify via n8n execution**

Send a test message. Inspect `Build draft setup data` output — should include `studio_collect_pricing_turns: 1` (or whichever stage) on first call. On clarify response from Claude, `next_setup_stage` should equal `current_setup_stage`.

---

## Task 6: WA_04 — Add `clarify` case to `Determine save action`

**Context:** `Determine save action` is a Switch with cases: 0=`save_draft`, 1=`commit`, 2=`none`. If Claude returns `action: "clarify"`, there is no matching case and the flow dies. Add case 3 = `clarify` routing to `Save draft to DB` (same destination as `save_draft`).

- [ ] **Step 6.1: Add `clarify` case to the Switch node**

Use `updateNode` or `patchNodeField` to add the case to `parameters.rules.values`:

```javascript
// patchNodeField on WA_04, node: "Determine save action", fieldPath: "parameters.rules.values"
// Append a new case object to the existing array.
// The existing array has 3 entries (indices 0-2). Add index 3:
{
  "conditions": {
    "options": { "caseSensitive": true, "leftValue": "", "typeValidation": "strict" },
    "conditions": [{
      "id": "clarify_check",
      "leftValue": "={{ $json.action }}",
      "rightValue": "clarify",
      "operator": { "type": "string", "operation": "equals" }
    }],
    "combinator": "and"
  },
  "renameOutput": true,
  "outputKey": "clarify"
}
```

Use `mcp__n8n-mcp__n8n_update_partial_workflow` with the current full rules array (fetch the node first with `n8n_get_workflow mode=full`, then patch with the extended array).

- [ ] **Step 6.2: Wire Switch case 3 (clarify) → `Save draft to DB`**

```javascript
{ "type": "addConnection", "source": "Determine save action", "target": "Save draft to DB", "sourceIndex": 3, "targetIndex": 0 }
```

- [ ] **Step 6.3: Verify Switch routing**

Temporarily set Claude to always return `"action": "clarify"` by editing one stage prompt, send a message, and verify in n8n execution that `Determine save action` routes to case 3 and `Save draft to DB` runs. Revert the temp prompt change.

---

## Task 7: WA_04 — Update all 12 stage nodes to use messages array + clarification instructions

**Context:** Every stage HTTP node currently has a single-item messages array with a user message. Replace with an IIFE expression that spreads `stage_history` before the current message. Add clarification instructions to each system prompt.

**Pattern for all stage nodes** (substitute stage-specific values):

```
={{ (() => {
  const history = $json.stage_history || [];
  const draft = JSON.stringify(JSON.stringify($json.draft_setup_data || {})).slice(1,-1);
  const msg = $json.message || '';
  const turns = ($json.draft_setup_data || {})[STAGE_KEY + '_turns'] || 0;
  const onFinalTurn = turns >= 2;
  const finalNote = onFinalTurn ? ' You are on your FINAL clarification turn — synthesize the best answer from all prior exchanges and return action: "save_draft".' : '';
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: `SYSTEM_PROMPT\n\nIf the answer is unclear or incomplete for this stage's purpose, return action: "clarify" with one focused follow-up question. If you have enough to work with, return action: "save_draft".${finalNote}`,
    messages: [...history, {role: 'user', content: `Stage: STAGE_KEY\n\nDraft so far: ${draft}\n\nMessage: ${msg}\n\nReturn ONLY valid JSON (no markdown):\nJSON_SCHEMA`}]
  };
})() }}
```

Apply the following for each node. The system prompt text and JSON schema come from the existing node (fetch before patching).

- [ ] **Step 7.1: Patch `Check archetype first visit` — N/A** (Code node, not HTTP, no change needed)

- [ ] **Step 7.2: Patch `Return archetype list` — N/A** (Code node, returns hardcoded JSON, no change needed)

- [ ] **Step 7.3: Patch `Collect business model`**

```javascript
// STAGE_KEY: collect_business_model
// SYSTEM_PROMPT: existing system prompt text (read current node first)
// JSON_SCHEMA: {"setup_response": "<Hebrew>", "extracted_value": "studio|service|other", "action": "save_draft or clarify"}
// Note: for collect_business_model, clarify is less likely (user picked from a list) but still supported
```

- [ ] **Step 7.4: Patch `Service collect offerings`**
```javascript
// STAGE_KEY: service_collect_offerings
// JSON_SCHEMA: {"setup_response": "<Hebrew>", "extracted_value": {"offerings": []}, "action": "save_draft or clarify"}
```

- [ ] **Step 7.5: Patch `Service collect target`**
```javascript
// STAGE_KEY: service_collect_target
// JSON_SCHEMA: {"setup_response": "<Hebrew>", "extracted_value": {"target_audience": ""}, "action": "save_draft or clarify"}
```

- [ ] **Step 7.6: Patch `Service collect urgency`**
```javascript
// STAGE_KEY: service_collect_urgency
// JSON_SCHEMA: {"setup_response": "<Hebrew>", "extracted_value": {"urgency_signals": []}, "action": "save_draft or clarify"}
```

- [ ] **Step 7.7: Patch `Studio collect classes`**
```javascript
// STAGE_KEY: studio_collect_classes
// JSON_SCHEMA: {"setup_response": "<Hebrew>", "extracted_value": {"classes": [], "schedule_description": null}, "action": "save_draft or clarify"}
```

- [ ] **Step 7.8: Patch `Studio collect pricing`**
```javascript
// STAGE_KEY: studio_collect_pricing
// JSON_SCHEMA: {"setup_response": "<Hebrew>", "extracted_value": {"pricing": ""}, "action": "save_draft or clarify"}
```

- [ ] **Step 7.9: Patch `Studio collect booking`**
```javascript
// STAGE_KEY: studio_collect_booking
// JSON_SCHEMA: {"setup_response": "<Hebrew>", "extracted_value": {"booking_method": ""}, "action": "save_draft or clarify"}
```

- [ ] **Step 7.10: Patch `Generic collect services`**
```javascript
// STAGE_KEY: generic_collect_services
// JSON_SCHEMA: {"setup_response": "<Hebrew>", "extracted_value": {"services": []}, "action": "save_draft or clarify"}
```

- [ ] **Step 7.11: Patch `Collect sales goal`**
```javascript
// STAGE_KEY: collect_sales_goal
// JSON_SCHEMA: {"setup_response": "<Hebrew>", "extracted_value": {"sales_goal": ""}, "action": "save_draft or clarify"}
```

- [ ] **Step 7.12: Patch `Collect persona definition`**
```javascript
// STAGE_KEY: collect_persona
// JSON_SCHEMA: {"setup_response": "<Hebrew>", "extracted_value": {"persona": {}}, "action": "save_draft or clarify"}
```

- [ ] **Step 7.13: Patch `Collect guardrails`**
```javascript
// STAGE_KEY: collect_guardrails
// JSON_SCHEMA: {"setup_response": "<Hebrew>", "extracted_value": null, "extracted_guardrails": {}, "action": "save_draft or clarify"}
```

- [ ] **Step 7.14: Patch `Confirm and review setup`** — no clarify here; this stage has its own IF logic, skip clarify addition.

- [ ] **Step 7.15: End-to-end test — clarification happy path**

1. Start a fresh setup session in wa-studio
2. Select Studio archetype
3. For the classes question, give a vague one-word answer (e.g. "sport")
4. Expected: Claude responds with a clarifying question and stays on `studio_collect_classes`
5. Give a proper answer: "yoga, pilates, CrossFit mornings and evenings"
6. Expected: Claude advances to `studio_collect_pricing`
7. Check `conversation_messages` in DB — should have 2 rows for `studio_collect_classes`, both with `setup_stage = 'studio_collect_classes'`
8. Check `setup_drafts` — should have `studio_collect_classes_turns: 2` in `draft_setup_data`

- [ ] **Step 7.16: End-to-end test — force-advance at turn 3**

1. Resume same session (or restart to `studio_collect_classes`)
2. Give vague answers 3 times in a row
3. Expected: on the 3rd turn, Claude advances regardless (no more clarifying question)
4. Check `studio_collect_classes_turns: 3` in `setup_drafts`
5. Verify stage in DB is now `studio_collect_pricing`

- [ ] **Step 7.17: End-to-end test — resume mid-clarification**

1. After step 7.15 turn 1 (clarification question was asked), kill the browser
2. Refresh wa-studio, resume the session
3. Send a new message
4. Expected: Claude receives the prior exchange in context and continues naturally

---

## Self-Review Notes

- **Task 2 wiring**: must remove old `Prepare setup state inputs` → `Save setup state` connection AFTER adding the new sequential path, otherwise both fire in parallel.
- **Task 6**: Fetching current `rules.values` array before patching is required — `patchNodeField` on an array needs the full new array, not just the appended item.
- **Task 7**: Read each node's current `jsonBody` before patching to preserve the exact system prompt text. The system prompts vary per stage and must not be lost.
- **Turn counter off-by-one**: `currentTurns` is incremented BEFORE checking `>= 3`, so turn 3 is the 3rd call (correct — user gets 2 clarifying questions max, 3rd call forces save).
