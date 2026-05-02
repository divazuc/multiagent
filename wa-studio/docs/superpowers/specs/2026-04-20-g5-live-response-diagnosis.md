# G5 — WA_02 / WA_03 Live-Response Diagnosis
**Date:** 2026-04-20
**Status:** Diagnosis complete. Three cascading bugs identified. No workflow changes shipped — patches applied and then reverted during diagnosis; live workflows are back to their pre-session state.

## Symptom (from 2026-04-20 audit)

Live-mode turns return a generic English greeting ("Hey there! What can I help you with today?") regardless of:
- Business archetype
- Business profile content (services, persona, sales goal)
- Customer message language (Hebrew input → English reply)

## Trace

Used the n8n executions API with `?includeData=true` to see node-by-node payloads for `WA_02_Load Session and Context` (id `QPvVdNYsEoqvOQ2R`) and `WA_03_Conversation Engine` (id `6YjROHmmOInYEMdb`).

## Finding 1 — WA_02 `Load business profile` throws on every call

**Node:** `WA_02 > Load business profile` (Postgres)

**Query:**
```sql
SELECT bp.business_id, bp.business_name, bp.business_model, ... bp.persona, bp.guardrails, bp.hebrew_patterns
FROM (SELECT '{{ $('Check session found').item.json.business_id }}'::uuid AS bid) dummy
LEFT JOIN business_profiles bp ON bp.business_id = dummy.bid
LIMIT 1;
```

**Error:** `operator does not exist: text = uuid`

**Root cause:** schema inconsistency.
- `businesses.id` is `uuid` (schema_v2 upgrade)
- `business_profiles.business_id` is `text` (schema.sql legacy)
- `sessions.business_id` is `text`

The query casts `dummy.bid` to `::uuid` then compares with `bp.business_id` which is `text`. Postgres has no implicit cast between them → operator error, LEFT JOIN returns all-NULL row, profile never loaded.

**Why the error didn't show up before:** WA_02's output is wrapped as `{status, result, error}`. When the query errors, n8n's `continueRegularOutput` (implicit default for Postgres node) swallows it and the downstream `Build context payload` sees empty `profile` → `persona: {}, services: [], ...`. Response pipeline keeps running; just produces empty-context generic responses.

**Fix:** remove the `::uuid` cast. Values stored are valid UUID strings; text-text comparison works. Verified during diagnosis by patching the query — load immediately returned proper profile data with persona, services, sales_goal, etc. populated.

## Finding 2 — WA_02 drops the user's `message` from its output

**Node:** `WA_02 > Build context payload` (Code) → `Return success` (Set)

`Build context payload` assembles the output json — but doesn't include `message` or `session_id`. Both fields are available in `$('Extract input fields').item.json` (they were read in at the top of the workflow) but the node just doesn't forward them.

**Consequence:** after Finding 1 is fixed, WA_03 can see profile/persona/guardrails but cannot see what the customer actually asked. Generate Candidate Response has no user message in its prompt context, produces an unrelated reply.

**Fix:** in `Build context payload`, add `message` and `session_id` to the returned json object. Values come from `$('Extract input fields').item.json.message` and `session.session_id`.

## Finding 3 — WA_03 `Extract Input Fields` reads the wrong path

**Node:** `WA_03 > Extract Input Fields` (Set)

**Current expressions:** `={{ $json.message }}`, `={{ $json.business_profile }}`, etc. — all at top level.

**Reality:** WA_03 is called as a sub-workflow from WA_00's `Run conversation engine`. Its input comes from WA_02's output — which is wrapped `{status, result: {...}, error}`. So `$json.message` is undefined (the real value is `$json.result.message`), `$json.business_profile` is undefined, etc. Extract Input Fields produces all-nulls; the HTTP prompt assembly gets empty context.

**Fix:** change each assignment to `={{ $json.result?.<field> ?? $json.<field> }}`. Same class of bug as the WA_06 payload mismatch found during the earlier live-flow audit.

## Finding 4 — **NEW BUG** surfaced by fixes 1–3: WA_03 `Generate Candidate Response` body template breaks on quote characters

After applying fixes 1–3 end-to-end during diagnosis, live turns returned `"An unexpected error occurred. Please try again."` The n8n execution showed:

**Node:** `WA_03 > Generate Candidate Response` (HTTP Request, sendBody=json)

**Error:** `The value in the "JSON Body" field is not valid JSON`

**Root cause:** the jsonBody uses template interpolation inside a JSON string:
```
"system": "... Persona: {{ JSON.stringify($('Parse Intent Analysis').first().json.persona) }} ..."
```

When persona is `{}`, `JSON.stringify({})` → `"{}"` → interpolates cleanly.

When persona has real content, e.g. `{name:"x"}`:
- `JSON.stringify({name:"x"})` → `'{"name":"x"}'`
- Interpolated into the outer string: `"system": "... {"name":"x"} ..."`
- The inner `"` characters terminate the outer string → invalid JSON

**Why this was latent:** Finding 1 meant persona/profile/services/guardrails/hebrew_patterns were always `{}` or empty. Serialized to `{}` or `[]`, no quotes, no problem. As soon as profile actually loads, every `{{ JSON.stringify(...) }}` site breaks.

**Reproduces on multiple lines:** the same pattern appears in the body template for:
- `Persona:` / `Business Profile:` / `Hebrew Patterns:` / `Guardrails:` / `FAQ Knowledge Base:` / `CTA Decision:` etc.

**Fix (one line each):** replace `{{ JSON.stringify(X) }}` with `{{ JSON.stringify(JSON.stringify(X)).slice(1, -1) }}`. The double-stringify escapes quotes; `.slice(1, -1)` strips the outer wrapping quotes; the result interpolates cleanly inside the outer JSON string.

Better fix (deferred): switch the HTTP body from a string-templated jsonBody to a structured object body — let n8n handle JSON serialization. Requires rewriting the Generate Candidate Response node's body parameters.

## Also observed (lower-priority, not fixed)

- WA_03's `Detect Intent and Qualify` HTTP body uses the same template pattern and would break identically once fed real data.
- `Parse Intent Analysis` outputs `language: 'english'` for Hebrew inputs — likely because the prompt lacks enough context to detect the real language when Extract produces nulls. Should self-resolve when Findings 1–3 land.
- `conversation_history` items come back with `role: null, content: null` — the Load conversation history query reads from a `conversations` view/table that might not be populated for live sessions. Separate issue.

## Recommended fix order

1. **Finding 1** — remove `::uuid` cast in WA_02 `Load business profile` (5 min, tiny risk)
2. **Finding 2** — forward `message` + `session_id` in WA_02 `Build context payload` (5 min)
3. **Finding 3** — patch WA_03 `Extract Input Fields` to read `$json.result?.<field>` (5 min)
4. **Finding 4** — double-stringify each `{{ JSON.stringify(...) }}` in WA_03 HTTP bodies (10 min; repeat for `Detect Intent and Qualify` too); add a test that exercises a profile with quote characters in persona/services content so this doesn't regress

Order 1→2→3→4 is strictly necessary; doing 1 alone surfaces bug 2, 1+2 surfaces bug 3, 1+2+3 surfaces bug 4. I stopped at 4 and reverted for this session because:
- Fixing 1–3 alone leaves live responses broken (HTTP 500 on every turn instead of "generic English")
- Fix 4 is template surgery on a live workflow; needs its own verification test
- A partial fix would be worse than the pre-session state

## What's in the current live workflows

- WA_02 — reverted to pre-session state (`::uuid` cast still present, build context payload still drops `message`)
- WA_03 — reverted to pre-session state (Extract Input Fields still reads flat `$json.*`)
- WA_04 — still has the session-advance CTE from earlier in this session (unrelated to G5, safe)
- WA_00 — still has the parallel `Prepare live save payload → Save live conversation` branch (the G1/G2/G4 fix from earlier this session, safe)

Tests: 10/10 passing post-revert (baseline restored).

## Out of scope (noted for later)

- Rewriting WA_03's HTTP body to use structured JSON instead of string-templated jsonBody (larger refactor — more robust long-term)
- The `conversations` table/view that `Load conversation history` reads from — verify it's being populated correctly for live sessions
- Language detection quality — currently depends on prompt context; may still produce wrong `language: english` labels in edge cases
- Schema normalization — the `text` vs `uuid` inconsistency between `businesses.id` and `business_profiles.business_id` / `sessions.business_id` is a latent hazard; doesn't need to be fixed now, but a future migration should unify them on uuid
