# Multi-Bot Switcher + Knowledge Interview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 3-bot "zone" switcher to the client dashboard (display layer over the existing domain classification) and a "questions from the field" knowledge-interview card (owner answers in free language → Claude polishes → lands in the existing FAQ suggestion strip), demo-ready for the Krupnik pitch.

**Architecture:** Zero schema changes. Bot definitions live in `business_profiles.draft_setup_data.dashboard_config.bots` (JSONB); interview state lives in `draft_setup_data.interview`. The server's existing per-session keyword classification (`getOverviewStats`) becomes config-driven and gains a `domain` filter param. The frontend mirrors the same classification client-side to filter leads and FAQ items. Two new Claude-backed server ops handle answer-polishing and question generation.

**Tech Stack:** Node/Express server (`server/`), Supabase JS client, `@anthropic-ai/sdk`, React 18 + Vite (`wa-studio/`), `node --test` for server tests.

**Spec:** `docs/superpowers/specs/2026-08-02-multibot-switcher-interview-design.md`

## Global Constraints

- Deadline-driven: cut order if time runs out is bot switcher first, interview second, live question generation last.
- Esthetic demo business id: `bdc47180-a3c1-47d0-9a51-fea4b2830fe2`. NEVER test against it — test chats/ops pollute the demo (create the scratch business in Task 9 instead).
- A business whose `dashboard_config` has no `bots` array must render and behave EXACTLY as today (regression guard: Dragons Kids).
- Sum invariant: the three bot views always partition the hub — classification assigns every session/lead/item to exactly one bot (or "shared" for FAQ items, shown in every bot).
- Bot display names (fixed copy): `הכשרות וקורסים` (id `doctors`), `טיפולים אסתטיים` (id `treatments`), `השתלות שיער` (id `hair`). Internal ids must stay `doctors`/`treatments`/`hair` — they match the existing `domains` keys.
- Bot colors come from the validated chart palette: doctors `#6d28d9`, treatments `#0d9488`, hair `#b45309`.
- Claude calls use model `claude-sonnet-4-6`, `ANTHROPIC_API_KEY` from env, via `@anthropic-ai/sdk` (already a server dependency).
- All user-facing copy is Hebrew; the dashboard is RTL.
- Server tests: `cd server && npm test`. There is no frontend test runner — frontend tasks end with concrete manual verification steps.
- Local run: server `cd server && node --env-file=.env.local index.js` (port 8080), frontend `cd wa-studio && npm run dev`, demo page `http://localhost:5173/demo?biz=<BIZ_ID>`.
- Commit after every task (messages given per task).

## File Structure

| File | Role |
|------|------|
| `server/lib/domain-classify.js` (create) | Pure classification helpers shared by overview stats; unit-tested |
| `server/lib/knowledge-interview.js` (create) | Interview state (JSONB read-merge-write), answer-polish flow, question generation; unit-tested via injected fake Claude |
| `server/lib/studio.js` (modify) | `getOverviewStats` domain param + config-driven tests; `getBotSettings` returns `bots`; new ops `updateBotIdentity`, `getInterviewQuestions`, `answerInterviewQuestion`, `dismissInterviewQuestion`, `generateInterviewQuestions` |
| `server/lib/portal.js` (modify) | Expose the new ops business-scoped; pass `domain` through `getOverviewStats` |
| `server/test/domain-classify.test.js` (create) | Classification unit tests |
| `server/test/knowledge-interview.test.js` (create) | Interview flow unit tests |
| `server/scripts/seed-esthetic-multibot.mjs` (create) | Idempotent seeder: bots config + 24 curated interview questions into a business's `draft_setup_data` |
| `wa-studio/src/demo/bots.js` (create) | Client-side mirror of classification + bot lookup helpers |
| `wa-studio/src/demo/BotSwitcher.jsx` (create) | The zone switcher bar |
| `wa-studio/src/demo/Interview.jsx` (create) | "שאלות מהשטח" card |
| `wa-studio/src/demo/ClientDashboard.jsx` (modify) | Load bots, own `activeBot` state, render switcher, filter inbox, pass props |
| `wa-studio/src/demo/Overview.jsx` (modify) | `domain` param, config-driven meta, share tile instead of donut in bot view, donut-click → bot |
| `wa-studio/src/demo/FaqSettings.jsx` (modify) | FAQ filtering + shared tag; Settings bot-identity card; render Interview card |
| `wa-studio/src/demo/api.js` (modify) | New ops on both clients; `domain` arg on `getOverviewStats` |
| `wa-studio/src/demo/demo.css` (modify) | Switcher, bot tags, share tile, interview card styles |

---

### Task 1: Server domain-classification helper

**Files:**
- Create: `server/lib/domain-classify.js`
- Test: `server/test/domain-classify.test.js`

**Interfaces:**
- Produces: `buildBotTests(bots) -> Array<{id, re}> | null`, `defaultBotId(bots) -> string | null`, `classifyText(text, bots) -> string | null`. `bots` is the config array `[{id, name, icon, color, panel, keywords}]` where `keywords` is a regex source string or `null` (null marks the default bot). Later tasks (2, 10) import these; the frontend mirrors `classifyText` in Task 4.

- [ ] **Step 1: Write the failing test**

```js
// server/test/domain-classify.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBotTests, defaultBotId, classifyText } from '../lib/domain-classify.js';

const BOTS = [
  { id: 'doctors', name: 'הכשרות וקורסים', keywords: 'קורס|רופא|הכשר|סילבוס|השתלמ|בי.?ה.?ס' },
  { id: 'treatments', name: 'טיפולים אסתטיים', keywords: null },
  { id: 'hair', name: 'השתלות שיער', keywords: 'שיער|גבות|זקן|השתל|קרקפת|נשיר|FUE' },
];

test('buildBotTests keeps array order and skips the default (null-keywords) bot', () => {
  const tests = buildBotTests(BOTS);
  assert.deepEqual(tests.map(t => t.id), ['doctors', 'hair']);
  assert.ok(tests[0].re.test('רוצה פרטים על קורס הזרקות'));
});

test('buildBotTests returns null when there is no usable config', () => {
  assert.equal(buildBotTests(null), null);
  assert.equal(buildBotTests([]), null);
  assert.equal(buildBotTests([{ id: 'x', keywords: null }]), null); // no testable bot
});

test('buildBotTests survives an invalid regex by skipping that bot', () => {
  const tests = buildBotTests([
    { id: 'bad', keywords: '[' },
    { id: 'hair', keywords: 'שיער' },
    { id: 'treatments', keywords: null },
  ]);
  assert.deepEqual(tests.map(t => t.id), ['hair']);
});

test('defaultBotId picks the first null-keywords bot, else the first bot', () => {
  assert.equal(defaultBotId(BOTS), 'treatments');
  assert.equal(defaultBotId([{ id: 'a', keywords: 'x' }, { id: 'b', keywords: 'y' }]), 'a');
  assert.equal(defaultBotId([]), null);
  assert.equal(defaultBotId(null), null);
});

test('classifyText: first matching bot in array order wins; no match falls to default', () => {
  assert.equal(classifyText('אני רופאה ומתעניינת בקורס', BOTS), 'doctors');
  // "קורס הזרקות" must classify as doctors even though הזרק could look treatment-y
  assert.equal(classifyText('כמה עולה קורס הזרקות?', BOTS), 'doctors');
  assert.equal(classifyText('שאלה על השתלת שיער', BOTS), 'hair');
  assert.equal(classifyText('רוצה לקבוע בוטוקס', BOTS), 'treatments');
  assert.equal(classifyText('', BOTS), 'treatments');
  assert.equal(classifyText('כל טקסט', null), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/domain-classify.test.js`
Expected: FAIL — `Cannot find module '../lib/domain-classify.js'`

- [ ] **Step 3: Write the implementation**

```js
// server/lib/domain-classify.js
//
// Bot/domain classification shared by the overview stats and (mirrored
// client-side in wa-studio/src/demo/bots.js) the dashboard filters. A "bots"
// config array lives in business_profiles.draft_setup_data.dashboard_config;
// keywords are regex sources, and the single bot with keywords === null is
// the default bucket for anything that matches nothing.

export function buildBotTests(bots) {
  if (!Array.isArray(bots)) return null;
  const tests = [];
  for (const b of bots) {
    if (!b?.id || !b.keywords) continue;
    try {
      tests.push({ id: b.id, re: new RegExp(b.keywords, 'i') });
    } catch { /* an invalid pattern must not take the dashboard down */ }
  }
  return tests.length ? tests : null;
}

export function defaultBotId(bots) {
  if (!Array.isArray(bots) || !bots.length) return null;
  return (bots.find(b => b && b.keywords == null) ?? bots[0]).id ?? null;
}

export function classifyText(text, bots) {
  const tests = buildBotTests(bots);
  if (!tests) return null;
  const hit = tests.find(t => t.re.test(text ?? ''));
  return hit ? hit.id : defaultBotId(bots);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/domain-classify.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add server/lib/domain-classify.js server/test/domain-classify.test.js
git commit -m "feat(dashboard): config-driven bot/domain classification helper"
```

---

### Task 2: `getOverviewStats` — config-driven classification + `domain` filter; `getBotSettings` returns `bots`

**Files:**
- Modify: `server/lib/studio.js:294-316` (getBotSettings), `server/lib/studio.js:316-445` (getOverviewStats)
- Modify: `server/lib/portal.js:113` (pass domain through)

**Interfaces:**
- Consumes: `buildBotTests`, `defaultBotId` from `server/lib/domain-classify.js` (Task 1).
- Produces: `getOverviewStats(businessId, days = 30, domain = null)` — when `domain` is a bot id, `daily` and `totals` cover only sessions classified to that bot; `domains` is ALWAYS the full (unfiltered) distribution keyed by bot id; response gains `domain` (echo, `null` for hub). `getBotSettings(businessId)` response gains `bots: Array | null` (from `draft_setup_data.dashboard_config.bots`) and must NOT leak the rest of `draft_setup_data`.

- [ ] **Step 1: Modify `getBotSettings`**

Add `draft_setup_data` to the select and expose only `bots` from it. Replace the current body's return section:

```js
  async getBotSettings(businessId) {
    if (!businessId) { const e = new Error('businessId is required'); e.status = 400; throw e; }
    const { data, error } = await supabase
      .from('business_profiles')
      .select('agent_active, answer_after_hours, working_hours, after_hours_message, followup_enabled, followup_delay_days, followup_message, guardrails, persona, agent_mode, cta_goal, push_speed, nudge_interval_hours, nudge_max_count, draft_setup_data')
      .eq('business_id', businessId)
      .maybeSingle();
    if (error) throw error;
    const { data: biz } = await supabase
      .from('businesses').select('portal_full_edit').eq('id', businessId).maybeSingle();
    // Only the bots array leaves the server — draft_setup_data holds internal
    // onboarding state that must not reach the client.
    const { draft_setup_data, ...rest } = data ?? {};
    return {
      ...rest,
      bots: draft_setup_data?.dashboard_config?.bots ?? null,
      portal_full_edit: biz?.portal_full_edit === true,
    };
  },
```

- [ ] **Step 2: Modify `getOverviewStats` signature and classification**

At the top of the file add the import (next to the existing imports):

```js
import { buildBotTests, defaultBotId } from './domain-classify.js';
```

Change the signature (`server/lib/studio.js:316`):

```js
  async getOverviewStats(businessId, days = 30, domain = null) {
```

Replace the hardcoded `DOMAIN_TESTS` block (the `const DOMAIN_TESTS = [...]` lines) with config-driven tests that fall back to the current behavior:

```js
    // Config-driven bot classification; the hardcoded pair mirrors the
    // original Esthetic three-domain split for businesses not yet seeded.
    const botsConfig = profile.draft_setup_data?.dashboard_config?.bots ?? null;
    const FALLBACK_BOTS = [
      ['doctors', /קורס|רופא|הכשר|סילבוס|השתלמ|בי.?ה.?ס/],
      ['hair', /שיער|גבות|זקן|השתל|קרקפת|נשיר|FUE/i],
    ];
    const botTests = buildBotTests(botsConfig)?.map(t => [t.id, t.re]) ?? FALLBACK_BOTS;
    const fallbackId = defaultBotId(botsConfig) ?? 'treatments';
```

- [ ] **Step 3: Restructure the aggregation into classify-then-aggregate**

The current single pass builds `daily` and `sessions` together; a domain filter needs session classification to exist before messages are bucketed. Replace the loop `for (const m of messages) { ... }` and the `const domains = ...` block with two passes:

```js
    // Pass 1 — build sessions and classify each one.
    const sessions = new Map(); // session_id -> {text, escalated, cta, after_hours_first}
    for (const m of messages) {
      const ah = isAfterHours(m.created_at);
      let s = sessions.get(m.session_id);
      if (!s) { s = { text: '', escalated: false, cta: false, after_hours_first: ah }; sessions.set(m.session_id, s); }
      s.text += ' ' + (m.user_message || '');
      if (m.escalate) s.escalated = true;
      if (m.cta_triggered) s.cta = true;
    }
    const sessionDomain = new Map();
    const domains = {};
    for (const b of (botsConfig ?? [])) domains[b.id] = 0;
    if (!botsConfig) { domains.treatments = 0; domains.hair = 0; domains.doctors = 0; }
    for (const [sid, s] of sessions) {
      const hit = botTests.find(([, re]) => re.test(s.text));
      const d = hit ? hit[0] : fallbackId;
      sessionDomain.set(sid, d);
      domains[d] = (domains[d] ?? 0) + 1;
    }

    // Pass 2 — aggregate, optionally scoped to one bot. `domains` above stays
    // unfiltered on purpose: the bot view's share tile needs the full split.
    const inScope = (sid) => !domain || sessionDomain.get(sid) === domain;
    let afterHoursMessages = 0, messagesInScope = 0;
    for (const m of messages) {
      if (!inScope(m.session_id)) continue;
      messagesInScope++;
      const bucket = daily.get(localDateKey(new Date(m.created_at)));
      const ah = isAfterHours(m.created_at);
      if (ah) afterHoursMessages++;
      if (bucket) {
        bucket.messages++;
        if (ah) bucket.after_hours++;
        bucket.sessions.add(m.session_id);
      }
    }
    let escalated = 0, cta = 0, afterHoursSessions = 0, conversationsInScope = 0;
    for (const [sid, s] of sessions) {
      if (!inScope(sid)) continue;
      conversationsInScope++;
      if (s.escalated) escalated++;
      if (s.cta) cta++;
      if (s.after_hours_first) afterHoursSessions++;
    }
```

Then update the return block: `conversations: conversationsInScope`, `messages: messagesInScope` (replacing `sessions.size` / `messages.length`), and add `domain: domain ?? null` as a top-level key next to `days`. Everything else in the return stays as is (`avg_reply_ms` and `contacts_*` intentionally stay business-wide — noted in the spec as acceptable).

- [ ] **Step 4: Pass `domain` through the portal op**

`server/lib/portal.js:113`:

```js
  getOverviewStats: (bizId, days, domain) => runStudioOp('getOverviewStats', [bizId, days, domain]),
```

- [ ] **Step 5: Verify — full test suite + a live smoke against Esthetic (read-only op, safe)**

Run: `cd server && npm test`
Expected: PASS (no existing test covers getOverviewStats; the suite guards against import/syntax breakage)

Run (server started with `node --env-file=.env.local index.js` in another shell):
```bash
curl -s http://localhost:8080/studio/rpc -H "Content-Type: application/json" \
  -d '{"fn":"getOverviewStats","args":["bdc47180-a3c1-47d0-9a51-fea4b2830fe2",30]}' | head -c 400
curl -s http://localhost:8080/studio/rpc -H "Content-Type: application/json" \
  -d '{"fn":"getOverviewStats","args":["bdc47180-a3c1-47d0-9a51-fea4b2830fe2",30,"hair"]}' | head -c 400
```
Expected: first call — same shape as before plus `"domain":null`, `domains` totals unchanged from pre-change behavior; second call — `totals.conversations` equals the first call's `domains.hair`, `domains` identical between both calls. (Reading Esthetic is safe; only writes pollute.)

- [ ] **Step 6: Commit**

```bash
git add server/lib/studio.js server/lib/portal.js
git commit -m "feat(overview): config-driven bots + per-bot domain filter in getOverviewStats"
```

---

### Task 3: `updateBotIdentity` op (server + portal)

**Files:**
- Modify: `server/lib/studio.js` (add op after `getBotSettings`)
- Modify: `server/lib/portal.js` (whitelist it)

**Interfaces:**
- Produces: studio op `updateBotIdentity(businessId, botId, patch)` where `patch` may contain only `name`, `panel`, `keywords`; merges into the matching `dashboard_config.bots[]` entry and returns the updated bots array. Portal op signature: `updateBotIdentity(botId, patch)` (bizId injected). Task 8's Settings card calls this.

- [ ] **Step 1: Add the studio op** (in `server/lib/studio.js`, right after `getBotSettings`)

```js
  // Per-bot identity edits from the dashboard. Read-merge-write on the JSONB:
  // single-writer demo/portal usage, so the race window is acceptable.
  async updateBotIdentity(businessId, botId, patch = {}) {
    if (!businessId || !botId) { const e = new Error('businessId and botId are required'); e.status = 400; throw e; }
    const allowed = {};
    for (const k of ['name', 'panel', 'keywords']) if (k in patch) allowed[k] = patch[k];
    const { data, error } = await supabase
      .from('business_profiles')
      .select('draft_setup_data')
      .eq('business_id', businessId)
      .maybeSingle();
    if (error) throw error;
    const draft = data?.draft_setup_data ?? {};
    const bots = draft.dashboard_config?.bots;
    if (!Array.isArray(bots) || !bots.some(b => b?.id === botId)) {
      const e = new Error(`unknown bot: ${botId}`); e.status = 404; throw e;
    }
    const next = bots.map(b => b.id === botId ? { ...b, ...allowed } : b);
    const { error: writeErr } = await supabase
      .from('business_profiles')
      .update({
        draft_setup_data: { ...draft, dashboard_config: { ...draft.dashboard_config, bots: next } },
        updated_at: new Date().toISOString(),
      })
      .eq('business_id', businessId);
    if (writeErr) throw writeErr;
    return next;
  },
```

- [ ] **Step 2: Whitelist in the portal** (`server/lib/portal.js`, next to `getBotSettings`)

```js
  updateBotIdentity: (bizId, botId, patch) => runStudioOp('updateBotIdentity', [bizId, botId, patch ?? {}]),
```

- [ ] **Step 3: Verify**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add server/lib/studio.js server/lib/portal.js
git commit -m "feat(dashboard): updateBotIdentity op for per-bot identity edits"
```

---

### Task 4: Frontend classification mirror + API client additions

**Files:**
- Create: `wa-studio/src/demo/bots.js`
- Modify: `wa-studio/src/demo/api.js`

**Interfaces:**
- Produces (bots.js): `classifyText(text, bots) -> botId | null`, `botById(bots, id) -> bot | null`, `leadBot(lead, bots) -> botId | null` (classifies `ai_summary + notes`), `itemBot(item, bots) -> botId | 'shared'` (an item whose question+answer matches NO keyworded bot is `'shared'`, not the default bot — FAQ semantics differ from session semantics on purpose: generic items belong everywhere).
- Produces (api.js): both clients gain `getOverviewStats(days, domain)`, `getInterviewQuestions()`, `answerInterviewQuestion(id, rawAnswer)`, `dismissInterviewQuestion(id)`, `generateInterviewQuestions(bot)`, `updateBotIdentity(botId, patch)`. Consumed by Tasks 5–8, 11.

- [ ] **Step 1: Create `wa-studio/src/demo/bots.js`**

```js
// Client-side mirror of server/lib/domain-classify.js — keep the two in sync.
// bots config: [{id, name, icon, color, panel, keywords}] where keywords is a
// regex source string; the single bot with keywords == null is the default.

export function buildBotTests(bots) {
  if (!Array.isArray(bots)) return null;
  const tests = []
  for (const b of bots) {
    if (!b?.id || !b.keywords) continue
    try { tests.push({ id: b.id, re: new RegExp(b.keywords, 'i') }) } catch { /* skip bad pattern */ }
  }
  return tests.length ? tests : null
}

export function defaultBotId(bots) {
  if (!Array.isArray(bots) || !bots.length) return null
  return (bots.find(b => b && b.keywords == null) ?? bots[0]).id ?? null
}

export function classifyText(text, bots) {
  const tests = buildBotTests(bots)
  if (!tests) return null
  const hit = tests.find(t => t.re.test(text ?? ''))
  return hit ? hit.id : defaultBotId(bots)
}

export function botById(bots, id) {
  return (bots ?? []).find(b => b?.id === id) ?? null
}

// A lead belongs to exactly one bot (sessions partition the hub).
export function leadBot(lead, bots) {
  return classifyText(`${lead?.ai_summary || ''} ${lead?.notes || ''}`, bots)
}

// FAQ items differ: an item that matches no keyworded bot is shared —
// location/hours/payment answers belong in every zone.
export function itemBot(item, bots) {
  const tests = buildBotTests(bots)
  if (!tests) return null
  const hit = tests.find(t => t.re.test(`${item?.question || ''} ${item?.answer || ''}`))
  return hit ? hit.id : 'shared'
}
```

- [ ] **Step 2: Extend both API clients in `wa-studio/src/demo/api.js`**

In `createDemoApi` replace the `getOverviewStats` line and add the new ops:

```js
    getOverviewStats: (days, domain) => rpc('getOverviewStats', bizId, days, domain ?? null),
    getInterviewQuestions: () => rpc('getInterviewQuestions', bizId),
    answerInterviewQuestion: (id, rawAnswer) => rpc('answerInterviewQuestion', bizId, id, rawAnswer),
    dismissInterviewQuestion: (id) => rpc('dismissInterviewQuestion', bizId, id),
    generateInterviewQuestions: (bot) => rpc('generateInterviewQuestions', bizId, bot ?? null),
    updateBotIdentity: (botId, patch) => rpc('updateBotIdentity', bizId, botId, patch),
```

In `createPortalApi` replace the `getOverviewStats` line and add (bizId is server-resolved):

```js
    getOverviewStats: (days, domain) => rpc('getOverviewStats', days, domain ?? null),
    getInterviewQuestions: () => rpc('getInterviewQuestions'),
    answerInterviewQuestion: (id, rawAnswer) => rpc('answerInterviewQuestion', id, rawAnswer),
    dismissInterviewQuestion: (id) => rpc('dismissInterviewQuestion', id),
    generateInterviewQuestions: (bot) => rpc('generateInterviewQuestions', bot ?? null),
    updateBotIdentity: (botId, patch) => rpc('updateBotIdentity', botId, patch),
```

- [ ] **Step 3: Verify the frontend still builds**

Run: `cd wa-studio && npm run build`
Expected: build succeeds (new ops are additive; interview ops don't exist server-side yet but nothing calls them).

- [ ] **Step 4: Commit**

```bash
git add wa-studio/src/demo/bots.js wa-studio/src/demo/api.js
git commit -m "feat(dashboard): client-side bot classification + api surface for bots and interview"
```

---

### Task 5: BotSwitcher + ClientDashboard wiring + inbox filtering

**Files:**
- Create: `wa-studio/src/demo/BotSwitcher.jsx`
- Modify: `wa-studio/src/demo/ClientDashboard.jsx`
- Modify: `wa-studio/src/demo/demo.css`

**Interfaces:**
- Consumes: `leadBot`, `botById` from `bots.js`; `api.getBotSettings()` (now returns `bots`).
- Produces: `<BotSwitcher bots active onSelect />`; ClientDashboard state `activeBot: string | null` (null = hub) passed to children as `bot`, plus `bots` and `onSelectBot` props on Overview (Task 6) and `bots`/`bot` on DemoFaq/DemoSettings (Tasks 7–8, 11).

- [ ] **Step 1: Create `wa-studio/src/demo/BotSwitcher.jsx`**

```jsx
import { botById } from './bots.js'

export default function BotSwitcher({ bots, active, onSelect }) {
  if (!bots?.length) return null
  const activeBot = botById(bots, active)
  return (
    <div className="bs-bar" role="tablist" aria-label="בחירת בוט">
      <button
        role="tab" aria-selected={!active}
        className={`bs-card ${!active ? 'on' : ''}`}
        onClick={() => onSelect(null)}
      >
        <span className="bs-icon">🏠</span>
        <span className="bs-name">מרכז</span>
        <span className="bs-panel">כל הבוטים יחד</span>
      </button>
      {bots.map(b => (
        <button
          key={b.id} role="tab" aria-selected={active === b.id}
          className={`bs-card ${active === b.id ? 'on' : ''}`}
          style={{ '--bot-color': b.color }}
          onClick={() => onSelect(b.id)}
        >
          <span className="bs-icon">{b.icon}</span>
          <span className="bs-name">{b.name}</span>
          <span className="bs-panel">
            <i className="bs-dot" aria-hidden="true" /> {b.panel}
          </span>
        </button>
      ))}
      {activeBot && (
        <div className="bs-active-note">
          מציג את הזון של <b>{activeBot.name}</b> בלבד
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Wire into `ClientDashboard.jsx`**

Add imports at the top:

```js
import BotSwitcher from './BotSwitcher.jsx'
import { leadBot, botById } from './bots.js'
```

Inside the component add state + bots loading (extend the existing mount effect that already calls `api.getBusinessName()` — add a third try block inside the same `(async () => { ... })()`):

```js
  const [bots, setBots] = useState(null)
  const [activeBot, setActiveBot] = useState(null)
```

```js
      try {
        const s = await api.getBotSettings()
        if (Array.isArray(s?.bots) && s.bots.length) setBots(s.bots)
      } catch { /* no switcher without config */ }
```

Add the bot-scoped lead list right after the `filtered` memo (`ClientDashboard.jsx:185-203`), and change `filtered`, the KPI strip, and the tag/status count memos to use it:

```js
  const botLeads = useMemo(
    () => (activeBot && bots) ? leads.filter(l => leadBot(l, bots) === activeBot) : leads,
    [leads, activeBot, bots]
  )
```

Replace every read of `leads` in: `tagCounts`, `statusCounts`, `filtered` (its `leads.filter` becomes `botLeads.filter` and dependency arrays gain `botLeads` instead of `leads`), the `activeCount`/`totalMessages` lines, the KPI `leads.length`, and the `ניקוי הסינון · מציג X מתוך Y` label — all move to `botLeads`. (`selectLead` and lead mutation logic keep using `leads`/`setLeads` — mutations must hit the master list.)

Render the switcher as the first child of `<main className="cd-main">`:

```jsx
        <BotSwitcher bots={bots} active={activeBot} onSelect={setActiveBot} />
```

Add the bot accent + name to the header — on the `<header>` element:

```jsx
      <header className="cd-header" style={activeBot ? { '--bot-color': botById(bots, activeBot)?.color } : undefined}>
```

and inside `.cd-brand`'s inner `<div>`, under the business name line:

```jsx
              {activeBot && <div className="cd-bot-context">{botById(bots, activeBot)?.icon} {botById(bots, activeBot)?.name}</div>}
```

In the hub view, add a small bot tag on each lead card — in the lead list render (`cd-lead-mid` block), after the status chip:

```jsx
                      {bots && !activeBot && (() => {
                        const b = botById(bots, leadBot(lead, bots))
                        return b ? <span className="cd-minitag cd-minitag-bot" style={{ '--bot-color': b.color }}>{b.icon} {b.name}</span> : null
                      })()}
```

Pass props to the children (Tasks 6–8 consume them; passing now keeps this task self-contained since extra props are ignored until then):

```jsx
        {view === 'overview' && <Overview api={api} bots={bots} bot={activeBot} onSelectBot={setActiveBot} />}
        {view === 'faq' && <DemoFaq api={api} showToast={showToast} bots={bots} bot={activeBot} />}
        {view === 'settings' && <DemoSettings api={api} showToast={showToast} bots={bots} bot={activeBot} onBotsChange={setBots} />}
```

- [ ] **Step 3: Add CSS** (append to `wa-studio/src/demo/demo.css`)

```css
/* ── Bot switcher ── */
.bs-bar { display: flex; gap: 10px; align-items: stretch; margin: 0 0 18px; overflow-x: auto; padding-bottom: 4px; }
.bs-card { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 168px;
  padding: 10px 14px; border: 1.5px solid #e2e8f0; border-radius: 14px; background: #fff;
  cursor: pointer; text-align: start; transition: border-color .15s, box-shadow .15s; }
.bs-card:hover { border-color: #cbd5e1; }
.bs-card.on { border-color: var(--bot-color, #0f766e); box-shadow: 0 0 0 3px color-mix(in srgb, var(--bot-color, #0f766e) 18%, transparent); }
.bs-icon { font-size: 20px; }
.bs-name { font-weight: 700; font-size: 14px; color: #0f172a; }
.bs-panel { font-size: 11px; color: #64748b; display: flex; align-items: center; gap: 4px; direction: ltr; }
.bs-dot { width: 7px; height: 7px; border-radius: 50%; background: #10b981; display: inline-block; }
.bs-active-note { align-self: center; font-size: 12.5px; color: #475569; margin-inline-start: 4px; white-space: nowrap; }
.cd-header[style*="--bot-color"] { box-shadow: inset 0 -4px 0 var(--bot-color); }
.cd-bot-context { font-size: 12px; font-weight: 600; color: #d1fae5; margin-top: 2px; }
.cd-minitag-bot { border: 1px solid color-mix(in srgb, var(--bot-color) 45%, transparent);
  color: color-mix(in srgb, var(--bot-color) 80%, #000); background: color-mix(in srgb, var(--bot-color) 8%, #fff); }
@media (max-width: 640px) { .bs-active-note { display: none; } .bs-card { min-width: 136px; } }
```

- [ ] **Step 4: Manual verification**

Start server + frontend (see Global Constraints). Open `http://localhost:5173/demo?biz=bdc47180-a3c1-47d0-9a51-fea4b2830fe2` (read-only browsing of Esthetic is fine — no writes):
1. No bots seeded yet → NO switcher appears, dashboard identical to today. This is the regression state.
2. Temporarily hardcode `setBots([{id:'doctors',name:'הכשרות וקורסים',icon:'🩺',color:'#6d28d9',panel:'פאנל 01 · 972-51-555-1111',keywords:'קורס|רופא|הכשר|סילבוס|השתלמ'},{id:'treatments',name:'טיפולים אסתטיים',icon:'💉',color:'#0d9488',panel:'פאנל 02 · 972-51-555-2222',keywords:null},{id:'hair',name:'השתלות שיער',icon:'💇',color:'#b45309',panel:'פאנל 03 · 972-51-555-3333',keywords:'שיער|גבות|זקן|השתל|קרקפת|נשיר|FUE'}])` in the mount effect → switcher renders; מרכז הלידים shows bot tags in hub, filters per bot, KPI counts change, sum of the three bots' lead counts equals the hub count.
3. Remove the hardcode before committing.

- [ ] **Step 5: Commit**

```bash
git add wa-studio/src/demo/BotSwitcher.jsx wa-studio/src/demo/ClientDashboard.jsx wa-studio/src/demo/demo.css
git commit -m "feat(dashboard): bot zone switcher with per-bot inbox filtering"
```

---

### Task 6: Overview per-bot view

**Files:**
- Modify: `wa-studio/src/demo/Overview.jsx`
- Modify: `wa-studio/src/demo/demo.css`

**Interfaces:**
- Consumes: props `{ api, bots, bot, onSelectBot }` (Task 5); `api.getOverviewStats(days, domain)` (Tasks 2+4); `botById` from `bots.js`.
- Produces: bot-scoped overview; donut only in hub, slice-click switches bot; share tile in bot view.

- [ ] **Step 1: Signature, data fetch, and meta**

```js
import { botById } from './bots.js'
```

```js
export default function Overview({ api, bots = null, bot = null, onSelectBot = null }) {
```

Fetch with the domain (the effect at `Overview.jsx:176-183`):

```js
    api.getOverviewStats(days, bot)
```
and add `bot` to that effect's dependency array: `[api, days, bot]`.

Derive the donut meta from config when present (replace the direct uses of the `DOMAIN_META` constant — keep the constant as fallback):

```js
  const domainMeta = useMemo(
    () => bots?.length
      ? bots.map(b => ({ key: b.id, label: b.name, color: b.color }))
      : DOMAIN_META,
    [bots]
  )
```

Pass `domainMeta` into `DomainDonut` as a prop (`<DomainDonut domains={domains} total={...} meta={domainMeta} onSelect={onSelectBot} />`) and inside `DomainDonut` change the signature to `function DomainDonut({ domains, total, meta, onSelect })`, replace `DOMAIN_META.map` with `meta.map`, and add `onClick={() => onSelect?.(e.key)}` + `style={{ cursor: onSelect ? 'pointer' : 'default', ... }}` on each `<circle>` and each legend `<li>`.

**Donut total fix:** the donut's `total` prop currently receives `totals.conversations`. In a bot view that's the filtered count while `domains` is the full split — but the donut only renders in hub view (next step), where they're equal. Change it anyway to be self-consistent: pass `total={Object.values(domains).reduce((a, b) => a + b, 0) || 1}`.

- [ ] **Step 2: Hub-only donut, share tile in bot view**

Replace the donut card section (`Overview.jsx:278-282`) with:

```jsx
        {!bot && (
          <section className="ov-card">
            <h3>התפלגות תחומי פנייה</h3>
            <div className="ov-card-sub">הבוט המרכזי מזהה את התחום ומנתב כל שיחה{onSelectBot ? ' · לחיצה על תחום פותחת את הזון שלו' : ''}</div>
            <DomainDonut domains={domains} total={Object.values(domains).reduce((a, b) => a + b, 0) || 1} meta={domainMeta} onSelect={onSelectBot} />
          </section>
        )}
        {bot && (() => {
          const b = botById(bots, bot)
          const grand = Object.values(domains).reduce((a, b2) => a + b2, 0)
          const share = grand ? Math.round(((domains[bot] ?? 0) / grand) * 100) : 0
          return (
            <section className="ov-card ov-share" style={{ '--bot-color': b?.color }}>
              <h3>{b?.icon} נתח {b?.name} מכלל הפעילות</h3>
              <div className="ov-share-num">{share}%</div>
              <div className="ov-share-sub">{(domains[bot] ?? 0).toLocaleString('he-IL')} מתוך {grand.toLocaleString('he-IL')} שיחות בתקופה</div>
              <div className="ov-share-rail"><div className="ov-share-fill" style={{ width: `${share}%` }} /></div>
            </section>
          )
        })()}
```

Also scope the hero label so the bot context is explicit — the `ov-hero-label` line becomes:

```jsx
          <div className="ov-hero-label">שווי עבודת המענה שהמערכת ביצעה ב-{stats.days} הימים האחרונים{bot ? ` · ${botById(bots, bot)?.name}` : ''}</div>
```

- [ ] **Step 3: CSS** (append to `demo.css`)

```css
/* ── Bot share tile (overview, bot view) ── */
.ov-share { display: flex; flex-direction: column; gap: 6px; }
.ov-share-num { font-size: 44px; font-weight: 800; color: var(--bot-color, #0f766e); line-height: 1; }
.ov-share-sub { font-size: 13px; color: #64748b; }
.ov-share-rail { height: 10px; border-radius: 6px; background: #f1f5f9; overflow: hidden; margin-top: 6px; }
.ov-share-fill { height: 100%; border-radius: 6px; background: var(--bot-color, #0f766e); transition: width .4s ease; }
```

- [ ] **Step 4: Manual verification**

With the Task 5 temporary hardcode re-applied (remove again after): hub shows the donut with the config names ("הכשרות וקורסים"); clicking the donut's hair slice switches the whole dashboard to השתלות שיער; the overview reloads with smaller totals; the share tile's percentage equals the hub donut's hair percentage; the daily bars show only that bot's activity. Switch back to מרכז — numbers return to the full totals.

- [ ] **Step 5: Commit**

```bash
git add wa-studio/src/demo/Overview.jsx wa-studio/src/demo/demo.css
git commit -m "feat(overview): per-bot zone view with share tile and donut drill-in"
```

---

### Task 7: FAQ tab per-bot filtering

**Files:**
- Modify: `wa-studio/src/demo/FaqSettings.jsx` (DemoFaq)
- Modify: `wa-studio/src/demo/demo.css`

**Interfaces:**
- Consumes: props `bots`, `bot` (Task 5); `itemBot`, `botById` from `bots.js`.
- Produces: `DemoFaq({ api, showToast, bots, bot })` — items and the suggestion strip filtered by zone; shared items visible in every zone with a "משותף" tag; hub shows bot tags.

- [ ] **Step 1: Implement filtering in DemoFaq**

```js
import { itemBot, botById } from './bots.js'
```

Change the signature: `export function DemoFaq({ api, showToast, bots = null, bot = null })`.

After the `suggested`/`active` lines (`FaqSettings.jsx:23-24`) add:

```js
  const inZone = (item) => {
    if (!bots || !bot) return true
    const b = itemBot(item, bots)
    return b === bot || b === 'shared'
  }
  const zoneSuggested = suggested.filter(inZone)
  const zoneActive = active.filter(inZone)
```

Replace `suggested.map` / `active.map` / `suggested.length` / the `active.filter(i => i.is_active).length` count with the `zone*` variants.

Add the tag chip to each FAQ item — inside `fq-item-top`, right after the category `<span className="fq-cat">` chip:

```jsx
              {bots && (() => {
                const b = itemBot(item, bots)
                if (b === 'shared') return <span className="fq-bot-tag fq-bot-shared">משותף</span>
                const meta = botById(bots, b)
                return meta ? <span className="fq-bot-tag" style={{ '--bot-color': meta.color }}>{meta.icon} {meta.name}</span> : null
              })()}
```

- [ ] **Step 2: CSS** (append to `demo.css`)

```css
/* ── FAQ bot tags ── */
.fq-bot-tag { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--bot-color, #64748b) 45%, transparent);
  color: color-mix(in srgb, var(--bot-color, #334155) 80%, #000);
  background: color-mix(in srgb, var(--bot-color, #64748b) 8%, #fff); }
.fq-bot-shared { --bot-color: #64748b; }
```

- [ ] **Step 3: Manual verification**

With the temporary bots hardcode: hub FAQ shows all 19 items, each tagged with a bot or משותף; switching to השתלות שיער hides קורסים items but keeps משותף ones (e.g. "איפה אתם נמצאים"); the suggestion strip follows the same rule; counts update.

- [ ] **Step 4: Commit**

```bash
git add wa-studio/src/demo/FaqSettings.jsx wa-studio/src/demo/demo.css
git commit -m "feat(faq): per-bot zone filtering with shared-item tags"
```

---

### Task 8: Settings — bot identity card

**Files:**
- Modify: `wa-studio/src/demo/FaqSettings.jsx` (DemoSettings)
- Modify: `wa-studio/src/demo/demo.css`

**Interfaces:**
- Consumes: props `bots`, `bot`, `onBotsChange` (Task 5); `api.updateBotIdentity(botId, patch)` (Tasks 3+4); `botById` from `bots.js`.
- Produces: in bot view, an editable identity card (name / panel / keywords) above the shared settings; shared settings get a "משותף לכל הבוטים" badge.

- [ ] **Step 1: Implement the card**

Change the signature: `export function DemoSettings({ api, showToast, bots = null, bot = null, onBotsChange = null })`.

Add state + save handler inside DemoSettings:

```js
  const activeBotMeta = botById(bots, bot)
  const [botDraft, setBotDraft] = useState(null) // {name, panel, keywords}
  const [botSaving, setBotSaving] = useState(false)

  useEffect(() => {
    setBotDraft(activeBotMeta ? { name: activeBotMeta.name, panel: activeBotMeta.panel ?? '', keywords: activeBotMeta.keywords ?? '' } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot])

  async function saveBotIdentity() {
    setBotSaving(true)
    try {
      const patch = { name: botDraft.name.trim() || activeBotMeta.name, panel: botDraft.panel.trim(),
                      keywords: botDraft.keywords.trim() || null }
      const next = await api.updateBotIdentity(bot, patch)
      onBotsChange?.(next)
      showToast('זהות הבוט עודכנה ✓')
    } catch {
      showToast('שמירת זהות הבוט נכשלה — נסו שוב')
    } finally {
      setBotSaving(false)
    }
  }
```

(`botById` is already imported into this file by Task 7.)

Render the card as the FIRST section inside the returned `st-page` div, before "מצב הסוכן":

```jsx
      {activeBotMeta && botDraft && (
        <section className="st-card st-bot-card" style={{ '--bot-color': activeBotMeta.color }}>
          <div className="st-sched-head">
            <h3>{activeBotMeta.icon} זהות הבוט — {activeBotMeta.name}</h3>
            <span className="st-bot-status"><i className="bs-dot" /> מחובר</span>
          </div>
          <label className="st-field-label" htmlFor="st-bot-name">שם הבוט</label>
          <input id="st-bot-name" className="st-input" value={botDraft.name}
                 onChange={e => setBotDraft(d => ({ ...d, name: e.target.value }))} />
          <label className="st-field-label" htmlFor="st-bot-panel">מספר וואטסאפ / פאנל מחובר</label>
          <input id="st-bot-panel" className="st-input" dir="ltr" value={botDraft.panel}
                 onChange={e => setBotDraft(d => ({ ...d, panel: e.target.value }))} />
          <label className="st-field-label" htmlFor="st-bot-kw">מילות סיווג (מפרידים ב-|) — לפיהן שיחות משויכות לבוט הזה</label>
          <input id="st-bot-kw" className="st-input" dir="rtl" value={botDraft.keywords}
                 placeholder="בוט ברירת המחדל — קולט כל שיחה שלא סווגה"
                 onChange={e => setBotDraft(d => ({ ...d, keywords: e.target.value }))} />
          <button className="st-save st-bot-save" onClick={saveBotIdentity} disabled={botSaving}>
            {botSaving ? 'שומר…' : 'שמירת זהות הבוט'}
          </button>
        </section>
      )}
```

Add the shared badge — in the "מצב הסוכן" and "שעות פעילות" section headers, when a bot is selected. For "מצב הסוכן", replace `<h3>מצב הסוכן</h3>` with:

```jsx
        <h3>מצב הסוכן {activeBotMeta && <span className="st-shared-badge">משותף לכל הבוטים</span>}</h3>
```

and in the schedule head, after `<h3>שעות פעילות</h3>` add:

```jsx
          {activeBotMeta && <span className="st-shared-badge">משותף לכל הבוטים</span>}
```

- [ ] **Step 2: CSS** (append to `demo.css`)

```css
/* ── Bot identity card (settings, bot view) ── */
.st-bot-card { border-inline-start: 4px solid var(--bot-color, #0f766e); }
.st-bot-status { font-size: 12.5px; color: #059669; display: flex; align-items: center; gap: 5px; }
.st-bot-save { margin-top: 10px; }
.st-shared-badge { font-size: 11px; font-weight: 600; color: #64748b; background: #f1f5f9;
  border-radius: 999px; padding: 2px 9px; margin-inline-start: 8px; vertical-align: middle; }
```

- [ ] **Step 3: Manual verification**

With the temporary hardcode active this card can't persist (no seeded config server-side yet) — verify rendering only: bot view shows the identity card with the bot's color rail, fields populated; hub view hides it; shared badges appear only in bot view. Persistence is verified in Task 9 after seeding. Remove the hardcode.

- [ ] **Step 4: Commit**

```bash
git add wa-studio/src/demo/FaqSettings.jsx wa-studio/src/demo/demo.css
git commit -m "feat(settings): per-bot identity card with shared-settings badges"
```

---

### Task 9: Seed script + scratch business + full feature-B E2E

**Files:**
- Create: `server/scripts/seed-esthetic-multibot.mjs`

**Interfaces:**
- Consumes: `server/lib/supabase.js` (env `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` — present in `server/.env.local`).
- Produces: `node --env-file=.env.local scripts/seed-esthetic-multibot.mjs <business_id> [--create-scratch]` — idempotently merges `dashboard_config.bots` and `interview.questions` into `draft_setup_data`. `--create-scratch` first creates a `multibot-e2e-scratch` business (is_test=true) and prints its id.

- [ ] **Step 1: Write the seeder**

```js
// server/scripts/seed-esthetic-multibot.mjs
//
// Seeds the multi-bot dashboard config + the knowledge-interview question
// bank into a business's draft_setup_data. Idempotent: bots are replaced
// wholesale; interview questions are appended only if their id is absent.
//
//   node --env-file=.env.local scripts/seed-esthetic-multibot.mjs <business_id>
//   node --env-file=.env.local scripts/seed-esthetic-multibot.mjs --create-scratch
import { supabase } from '../lib/supabase.js';

const BOTS = [
  { id: 'doctors', name: 'הכשרות וקורסים', icon: '🩺', color: '#6d28d9',
    panel: 'פאנל 01 · 972-51-555-1111', keywords: 'קורס|רופא|הכשר|סילבוס|השתלמ|בי.?ה.?ס' },
  { id: 'treatments', name: 'טיפולים אסתטיים', icon: '💉', color: '#0d9488',
    panel: 'פאנל 02 · 972-51-555-2222', keywords: null },
  { id: 'hair', name: 'השתלות שיער', icon: '💇', color: '#b45309',
    panel: 'פאנל 03 · 972-51-555-3333', keywords: 'שיער|גבות|זקן|השתל|קרקפת|נשיר|FUE' },
];

const Q = (id, bot, text) => ({ id, bot, text, source: 'curated', status: 'open', raw_answer: null, knowledge_item_id: null, answered_at: null });
const QUESTIONS = [
  Q('iq_doc_01', 'doctors', 'אני אחות מוסמכת, לא רופאה — אפשר להירשם לקורס הזרקות?'),
  Q('iq_doc_02', 'doctors', 'הקורס כולל התנסות מעשית על מטופלים אמיתיים או רק תיאוריה?'),
  Q('iq_doc_03', 'doctors', 'כמה משתתפים יש בקבוצה, ויש ליווי אחרי הקורס?'),
  Q('iq_doc_04', 'doctors', 'מקבלים תעודה בסוף הקורס? היא מוכרת איפשהו?'),
  Q('iq_doc_05', 'doctors', 'אילו מסלולי המשך יש אחרי קורס הבסיס?'),
  Q('iq_doc_06', 'doctors', 'הקורסים מתקיימים גם בסופי שבוע או רק באמצע השבוע?'),
  Q('iq_doc_07', 'doctors', 'רופא שיניים יכול להשתתף בקורס הזרקות בוטוקס?'),
  Q('iq_doc_08', 'doctors', 'אפשר לשלם על הקורס בתשלומים?'),
  Q('iq_trt_01', 'treatments', 'בת כמה צריך להיות בשביל בוטוקס מניעתי?'),
  Q('iq_trt_02', 'treatments', 'כמה זמן מחזיק מילוי שפתיים, ומה קורה כשזה מתפוגג?'),
  Q('iq_trt_03', 'treatments', 'אפשר לעשות בוטוקס בהריון או בהנקה?'),
  Q('iq_trt_04', 'treatments', 'מה ההבדל בין פרופיילו לחומצה היאלורונית?'),
  Q('iq_trt_05', 'treatments', 'יש נפיחות אחרי הזרקות? תוך כמה זמן חוזרים לשגרה?'),
  Q('iq_trt_06', 'treatments', 'אתם מטפלים גם בגברים?'),
  Q('iq_trt_07', 'treatments', 'הפגישה הראשונה היא ייעוץ? היא בתשלום?'),
  Q('iq_trt_08', 'treatments', 'איך אני יודעת שהמזריק מוסמך ושבטוח לעשות את זה אצלכם?'),
  Q('iq_hair_01', 'hair', 'אחרי כמה זמן רואים תוצאות מהשתלת שיער?'),
  Q('iq_hair_02', 'hair', 'ההשתלה כואבת? כמה ימי החלמה צריך?'),
  Q('iq_hair_03', 'hair', 'אתם עושים גם השתלת זקן ושפם?'),
  Q('iq_hair_04', 'hair', 'אני אישה עם שיער דליל בקו הקדמי — השתלה מתאימה גם לנשים?'),
  Q('iq_hair_05', 'hair', 'מה ההבדל בין שיטת FUE לשיטות אחרות?'),
  Q('iq_hair_06', 'hair', 'השיער המושתל נושר אחרי תקופה? צריך טיפוח מיוחד?'),
  Q('iq_hair_07', 'hair', 'עשיתי השתלה במקום אחר ואני לא מרוצה — אפשר לתקן?'),
  Q('iq_hair_08', 'hair', 'כמה זקיקים צריך בערך לקו שיער קדמי?'),
];

async function createScratch() {
  const { data: biz, error } = await supabase.from('businesses')
    .insert({ name: 'Multibot E2E Scratch', slug: 'multibot-e2e-scratch-' + Date.now().toString(36), archetype: 'service', is_test: true })
    .select('id').single();
  if (error) throw error;
  const { error: pErr } = await supabase.from('business_profiles').insert({ business_id: biz.id });
  if (pErr) throw pErr;
  console.log('scratch business created:', biz.id);
  return biz.id;
}

async function main() {
  let bizId = process.argv[2];
  if (bizId === '--create-scratch') bizId = await createScratch();
  if (!bizId) { console.error('usage: seed-esthetic-multibot.mjs <business_id> | --create-scratch'); process.exit(1); }

  const { data, error } = await supabase.from('business_profiles')
    .select('draft_setup_data').eq('business_id', bizId).maybeSingle();
  if (error) throw error;
  if (!data) { console.error('no business_profiles row for', bizId); process.exit(1); }

  const draft = data.draft_setup_data ?? {};
  const existing = draft.interview?.questions ?? [];
  const have = new Set(existing.map(q => q.id));
  const merged = [...existing, ...QUESTIONS.filter(q => !have.has(q.id))];

  const { error: wErr } = await supabase.from('business_profiles').update({
    draft_setup_data: {
      ...draft,
      dashboard_config: { ...draft.dashboard_config, bots: BOTS },
      interview: { ...draft.interview, questions: merged },
    },
    updated_at: new Date().toISOString(),
  }).eq('business_id', bizId);
  if (wErr) throw wErr;

  console.log(`seeded ${bizId}: ${BOTS.length} bots, ${merged.length} interview questions (${merged.length - existing.length} new)`);
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Create the scratch business and seed it**

Run: `cd server && node --env-file=.env.local scripts/seed-esthetic-multibot.mjs --create-scratch`
Expected: prints the scratch id. Record it as `<SCRATCH_ID>` for all remaining tasks.

- [ ] **Step 3: Feature-B E2E on the scratch business**

Open `http://localhost:5173/demo?biz=<SCRATCH_ID>`:
1. Switcher renders from REAL config (no hardcode anywhere).
2. Empty-data states behave: overview shows "הנתונים מתחילים להיאסף", inbox shows the sample-fixtures state.
3. Settings → pick a bot → identity card: change the panel string, save, refresh the page — the change persisted (round-trips through `updateBotIdentity` + `getBotSettings`).
4. Open `http://localhost:5173/demo?biz=bdc47180-a3c1-47d0-9a51-fea4b2830fe2` (Esthetic, still unseeded) → NO switcher, dashboard exactly as in prod today. Regression confirmed.

- [ ] **Step 4: Commit**

```bash
git add server/scripts/seed-esthetic-multibot.mjs
git commit -m "feat(dashboard): multibot + interview seeder with scratch-business mode"
```

---

### Task 10: Knowledge-interview server module + ops

**Files:**
- Create: `server/lib/knowledge-interview.js`
- Modify: `server/lib/studio.js` (register 4 thin ops)
- Modify: `server/lib/portal.js` (whitelist them)
- Test: `server/test/knowledge-interview.test.js`

**Interfaces:**
- Consumes: `supabase` from `server/lib/supabase.js`; `@anthropic-ai/sdk`; knowledge_items insert shape from `checkAndSuggestFaq` (`server/index.js:759-771`): `{business_id, category, question, answer, is_active: false, suggested: true, language: 'he'}`.
- Produces (module exports, also exposed 1:1 as studio ops with the same names):
  - `getInterviewQuestions(businessId) -> {questions: [...]}` (open only)
  - `answerInterviewQuestion(businessId, questionId, rawAnswer) -> {item, question}` — item is the inserted knowledge_items row
  - `dismissInterviewQuestion(businessId, questionId) -> {ok: true}`
  - `generateInterviewQuestions(businessId, bot) -> {questions: [...]}` (the newly added ones)
  - `_setClaudeForTest(fn)` — test seam, same pattern as `agents/demo.js`'s `_setExtractorForTest`
  - `parseJsonResponse(raw)` — exported for tests

- [ ] **Step 1: Write the failing tests**

```js
// server/test/knowledge-interview.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'test-key-unused';
const ki = await import('../lib/knowledge-interview.js');

// In-memory stand-in for the two tables the module touches.
function fakeDb(draft) {
  const state = {
    draft: { draft_setup_data: draft },
    profileRow: { business_name: 'אסתטיק קליניק', persona: { bot_name: 'סאלי', bot_gender: 'female' }, guardrails: { forbidden_topics: ['מסירת מחירים בוואטסאפ'] } },
    inserted: [],
    updates: [],
  };
  ki._setDbForTest({
    async loadDraft() { return state.draft; },
    async saveDraft(d) { state.updates.push(d); state.draft = { draft_setup_data: d }; },
    async loadProfile() { return state.profileRow; },
    async loadFaqQuestions() { return ['כמה זמן מראש צריך לקבוע תור?']; },
    async insertKnowledgeItem(row) { const r = { id: 'ki_' + state.inserted.length, ...row }; state.inserted.push(r); return r; },
  });
  return state;
}

const OPEN_Q = { id: 'iq_1', bot: 'hair', text: 'ההשתלה כואבת?', source: 'curated', status: 'open', raw_answer: null, knowledge_item_id: null, answered_at: null };

test('getInterviewQuestions returns only open questions', async () => {
  fakeDb({ interview: { questions: [OPEN_Q, { ...OPEN_Q, id: 'iq_2', status: 'answered' }] } });
  const { questions } = await ki.getInterviewQuestions('b1');
  assert.deepEqual(questions.map(q => q.id), ['iq_1']);
});

test('answerInterviewQuestion: polish → suggested item → question marked answered', async () => {
  const db = fakeDb({ interview: { questions: [{ ...OPEN_Q }] } });
  ki._setClaudeForTest(async () => '```json\n{"question":"האם השתלת שיער כואבת?","answer":"התהליך בהרדמה מקומית ורוב המטופלים חוזרים לשגרה תוך יומיים.","category":"services"}\n```');
  const { item, question } = await ki.answerInterviewQuestion('b1', 'iq_1', 'זה לא כואב, הרדמה מקומית, יומיים מנוחה');
  assert.equal(item.suggested, true);
  assert.equal(item.is_active, false);
  assert.equal(item.category, 'services');
  assert.equal(question.status, 'answered');
  assert.equal(question.knowledge_item_id, item.id);
  const saved = db.state.draft.draft_setup_data.interview.questions[0];
  assert.equal(saved.status, 'answered');
  assert.equal(saved.raw_answer, 'זה לא כואב, הרדמה מקומית, יומיים מנוחה');
});

test('answerInterviewQuestion: failed polish keeps the question open with the raw answer saved', async () => {
  const db = fakeDb({ interview: { questions: [{ ...OPEN_Q }] } });
  ki._setClaudeForTest(async () => 'מצטער, איני יכול');
  await assert.rejects(() => ki.answerInterviewQuestion('b1', 'iq_1', 'תשובה גולמית'), /polish/);
  const saved = db.state.draft.draft_setup_data.interview.questions[0];
  assert.equal(saved.status, 'open');
  assert.equal(saved.raw_answer, 'תשובה גולמית');
  assert.equal(db.state.inserted.length, 0);
});

test('answerInterviewQuestion rejects an unknown or non-open question', async () => {
  fakeDb({ interview: { questions: [{ ...OPEN_Q, status: 'answered' }] } });
  await assert.rejects(() => ki.answerInterviewQuestion('b1', 'iq_1', 'x'), /not open/);
  await assert.rejects(() => ki.answerInterviewQuestion('b1', 'iq_missing', 'x'), /not open/);
});

test('dismissInterviewQuestion marks dismissed', async () => {
  const db = fakeDb({ interview: { questions: [{ ...OPEN_Q }] } });
  await ki.dismissInterviewQuestion('b1', 'iq_1');
  assert.equal(db.state.draft.draft_setup_data.interview.questions[0].status, 'dismissed');
});

test('generateInterviewQuestions appends deduped questions as generated', async () => {
  const db = fakeDb({ interview: { questions: [{ ...OPEN_Q }] } });
  ki._setClaudeForTest(async () => JSON.stringify({ questions: [
    'ההשתלה כואבת?',                       // dup of an existing interview question — dropped
    'כמה זמן מראש צריך לקבוע תור?',        // dup of an existing FAQ question — dropped
    'אפשר לעשות השתלת שיער בגיל 25?',      // new
  ] }));
  const { questions } = await ki.generateInterviewQuestions('b1', 'hair');
  assert.equal(questions.length, 1);
  assert.equal(questions[0].bot, 'hair');
  assert.equal(questions[0].source, 'generated');
  assert.equal(questions[0].status, 'open');
  assert.equal(db.state.draft.draft_setup_data.interview.questions.length, 2);
});

test('parseJsonResponse strips fences and rejects non-JSON', () => {
  assert.deepEqual(ki.parseJsonResponse('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(ki.parseJsonResponse('{"a":1}'), { a: 1 });
  assert.equal(ki.parseJsonResponse('לא JSON'), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && node --test test/knowledge-interview.test.js`
Expected: FAIL — `Cannot find module '../lib/knowledge-interview.js'`

- [ ] **Step 3: Write the module**

```js
// server/lib/knowledge-interview.js
//
// The ongoing knowledge-enrichment interview: curated/generated questions live
// in business_profiles.draft_setup_data.interview; a free-language owner
// answer is polished by Claude into a suggested knowledge_item that lands in
// the FAQ tab's existing approval strip. Read-merge-write on the JSONB is
// acceptable here: a single owner edits their own dashboard.

const CATEGORIES = ['general', 'services', 'pricing', 'booking', 'scheduling', 'location', 'safety', 'trial'];
const MODEL = 'claude-sonnet-4-6';

let _claude = null;   // test seam: async (prompt, maxTokens) => text
let _db = null;       // test seam: {loadDraft, saveDraft, loadProfile, loadFaqQuestions, insertKnowledgeItem}
export function _setClaudeForTest(fn) { _claude = fn; }
export function _setDbForTest(db) { _db = db; }

async function db() {
  if (_db) return _db;
  const { supabase } = await import('./supabase.js');
  return {
    async loadDraft(businessId) {
      const { data, error } = await supabase.from('business_profiles')
        .select('draft_setup_data').eq('business_id', businessId).maybeSingle();
      if (error) throw error;
      return data;
    },
    async saveDraft(businessId, draft) {
      const { error } = await supabase.from('business_profiles')
        .update({ draft_setup_data: draft, updated_at: new Date().toISOString() })
        .eq('business_id', businessId);
      if (error) throw error;
    },
    async loadProfile(businessId) {
      const [{ data: prof }, { data: biz }] = await Promise.all([
        supabase.from('business_profiles').select('persona, guardrails').eq('business_id', businessId).maybeSingle(),
        supabase.from('businesses').select('name').eq('id', businessId).maybeSingle(),
      ]);
      return { business_name: biz?.name ?? '', persona: prof?.persona ?? {}, guardrails: prof?.guardrails ?? {} };
    },
    async loadFaqQuestions(businessId) {
      const { data } = await supabase.from('knowledge_items')
        .select('question').eq('business_id', businessId);
      return (data ?? []).map(r => r.question);
    },
    async insertKnowledgeItem(row) {
      const { data, error } = await supabase.from('knowledge_items').insert(row).select().maybeSingle();
      if (error) throw error;
      return data;
    },
  };
}

async function callClaude(prompt, maxTokens = 700) {
  if (_claude) return _claude(prompt, maxTokens);
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: MODEL, max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.content[0]?.text ?? '';
}

export function parseJsonResponse(raw) {
  if (!raw) return null;
  const m = String(raw).match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function loadInterviewState(businessId) {
  const d = await db();
  const row = await d.loadDraft(businessId);
  if (!row) { const e = new Error('business profile not found'); e.status = 404; throw e; }
  const draft = row.draft_setup_data ?? {};
  return { d, draft, questions: draft.interview?.questions ?? [] };
}

async function saveQuestions(d, businessId, draft, questions) {
  await d.saveDraft(businessId, { ...draft, interview: { ...draft.interview, questions } });
}

export async function getInterviewQuestions(businessId) {
  const { questions } = await loadInterviewState(businessId);
  return { questions: questions.filter(q => q.status === 'open') };
}

export async function dismissInterviewQuestion(businessId, questionId) {
  const { d, draft, questions } = await loadInterviewState(businessId);
  const next = questions.map(q => q.id === questionId ? { ...q, status: 'dismissed' } : q);
  await saveQuestions(d, businessId, draft, next);
  return { ok: true };
}

const norm = (s) => String(s ?? '').replace(/[?״"׳'.,!]/g, '').replace(/\s+/g, ' ').trim();

export async function answerInterviewQuestion(businessId, questionId, rawAnswer) {
  if (!rawAnswer?.trim()) { const e = new Error('rawAnswer is required'); e.status = 400; throw e; }
  const { d, draft, questions } = await loadInterviewState(businessId);
  const q = questions.find(x => x.id === questionId && x.status === 'open');
  if (!q) { const e = new Error('question not open'); e.status = 404; throw e; }

  // Persist the raw answer BEFORE the model call — it must survive a failed polish.
  let next = questions.map(x => x.id === questionId ? { ...x, raw_answer: rawAnswer } : x);
  await saveQuestions(d, businessId, draft, next);

  const profile = await d.loadProfile(businessId);
  const guardLines = [
    ...(profile.guardrails.forbidden_topics ?? []),
    profile.guardrails.forbidden_custom,
  ].filter(Boolean).map(t => `- ${t}`).join('\n');

  const prompt = `אתה עוזר לבעל עסק להפוך תשובה גולמית לפריט שאלות-ותשובות מלוטש עבור סוכן וואטסאפ.

העסק: ${profile.business_name}
${profile.persona.bot_name ? `שם הבוט: ${profile.persona.bot_name} (לשון ${profile.persona.bot_gender === 'male' ? 'זכר' : 'נקבה'})` : ''}
${guardLines ? `נושאים שהבוט לעולם אינו עונה עליהם ישירות (אם התשובה נוגעת בהם — נסח הפניה לנציגה במקום פירוט):\n${guardLines}` : ''}

השאלה כפי שלקוחות שואלים אותה: ${q.text}
התשובה הגולמית של בעל העסק (בשפתו החופשית): ${rawAnswer}

נסח מחדש: שאלה קצרה וטבעית (קרובה למקור) ותשובה חמה ומקצועית בקול המותג, 2–4 משפטים, בלי להמציא עובדות שאינן בתשובת הבעלים. בחר category מתוך: ${CATEGORIES.join(', ')}.

החזר JSON בלבד: {"question": "...", "answer": "...", "category": "..."}`;

  const parsed = parseJsonResponse(await callClaude(prompt, 700));
  if (!parsed?.question || !parsed?.answer) {
    const e = new Error('polish failed — raw answer saved, try again'); e.status = 502; throw e;
  }

  const item = await d.insertKnowledgeItem({
    business_id: businessId,
    category: CATEGORIES.includes(parsed.category) ? parsed.category : 'general',
    question: parsed.question,
    answer: parsed.answer,
    is_active: false,
    suggested: true,
    language: 'he',
  });

  next = next.map(x => x.id === questionId
    ? { ...x, status: 'answered', knowledge_item_id: item.id, answered_at: new Date().toISOString() }
    : x);
  await saveQuestions(d, businessId, draft, next);
  return { item, question: next.find(x => x.id === questionId) };
}

export async function generateInterviewQuestions(businessId, bot = null) {
  const { d, draft, questions } = await loadInterviewState(businessId);
  const profile = await d.loadProfile(businessId);
  const faq = await d.loadFaqQuestions(businessId);
  const known = new Set([...questions.map(q => norm(q.text)), ...faq.map(norm)]);

  const botMeta = (draft.dashboard_config?.bots ?? []).find(b => b.id === bot);
  const prompt = `אתה אוסף שאלות אמיתיות שלקוחות שואלים ברשת (פורומים, קבוצות, גוגל) על עסקים כמו זה:

העסק: ${profile.business_name}
${botMeta ? `התחום המבוקש: ${botMeta.name}` : 'כל תחומי העסק'}

שאלות שכבר קיימות במאגר (אל תחזור עליהן או על ניסוח דומה):
${[...questions.map(q => q.text), ...faq].map(t => `- ${t}`).join('\n')}

כתוב 3–5 שאלות חדשות, מנוסחות בדיוק כמו שלקוח אמיתי כותב (טבעי, לא פורמלי).
החזר JSON בלבד: {"questions": ["...", "..."]}`;

  const parsed = parseJsonResponse(await callClaude(prompt, 600));
  const texts = Array.isArray(parsed?.questions) ? parsed.questions : [];
  const fresh = texts
    .map(t => String(t).trim()).filter(Boolean)
    .filter(t => !known.has(norm(t)))
    .map((t, i) => ({
      id: `iq_gen_${Date.now().toString(36)}_${i}`,
      bot: bot ?? botMeta?.id ?? null,
      text: t, source: 'generated', status: 'open',
      raw_answer: null, knowledge_item_id: null, answered_at: null,
    }));
  if (fresh.length) await saveQuestions(d, businessId, draft, [...questions, ...fresh]);
  return { questions: fresh };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && node --test test/knowledge-interview.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Register studio ops** (`server/lib/studio.js`, after `updateBotIdentity`)

```js
  // ── Knowledge interview (see lib/knowledge-interview.js) ───────────────────
  async getInterviewQuestions(businessId) {
    const ki = await import('./knowledge-interview.js');
    return ki.getInterviewQuestions(businessId);
  },
  async answerInterviewQuestion(businessId, questionId, rawAnswer) {
    const ki = await import('./knowledge-interview.js');
    return ki.answerInterviewQuestion(businessId, questionId, rawAnswer);
  },
  async dismissInterviewQuestion(businessId, questionId) {
    const ki = await import('./knowledge-interview.js');
    return ki.dismissInterviewQuestion(businessId, questionId);
  },
  async generateInterviewQuestions(businessId, bot) {
    const ki = await import('./knowledge-interview.js');
    return ki.generateInterviewQuestions(businessId, bot);
  },
```

- [ ] **Step 6: Whitelist in the portal** (`server/lib/portal.js`, next to the other passthroughs)

```js
  getInterviewQuestions:      (bizId) => runStudioOp('getInterviewQuestions', [bizId]),
  answerInterviewQuestion:    (bizId, id, raw) => runStudioOp('answerInterviewQuestion', [bizId, id, raw]),
  dismissInterviewQuestion:   (bizId, id) => runStudioOp('dismissInterviewQuestion', [bizId, id]),
  generateInterviewQuestions: (bizId, bot) => runStudioOp('generateInterviewQuestions', [bizId, bot ?? null]),
```

- [ ] **Step 7: Run the full suite**

Run: `cd server && npm test`
Expected: PASS, all files.

- [ ] **Step 8: Commit**

```bash
git add server/lib/knowledge-interview.js server/lib/studio.js server/lib/portal.js server/test/knowledge-interview.test.js
git commit -m "feat(interview): knowledge-enrichment interview ops — polish, dismiss, generate"
```

---

### Task 11: Interview UI card

**Files:**
- Create: `wa-studio/src/demo/Interview.jsx`
- Modify: `wa-studio/src/demo/FaqSettings.jsx` (render it in DemoFaq)
- Modify: `wa-studio/src/demo/demo.css`

**Interfaces:**
- Consumes: `api.getInterviewQuestions/answerInterviewQuestion/dismissInterviewQuestion/generateInterviewQuestions` (Tasks 4+10); props `bots`, `bot`; `botById` from `bots.js`.
- Produces: `<InterviewCard api bots bot showToast onSuggested />` — `onSuggested(item)` fires with the new knowledge_items row so DemoFaq appends it to its list (the suggestion strip updates live).

- [ ] **Step 1: Create `wa-studio/src/demo/Interview.jsx`**

```jsx
import { useState, useEffect } from 'react'
import { botById } from './bots.js'

export default function InterviewCard({ api, bots = null, bot = null, showToast, onSuggested }) {
  const [questions, setQuestions] = useState(null)
  const [drafts, setDrafts] = useState({})      // id -> text
  const [busy, setBusy] = useState({})          // id -> true while sending
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState(false)

  useEffect(() => {
    api.getInterviewQuestions?.().then(r => setQuestions(r.questions ?? [])).catch(() => setQuestions([]))
  }, [api])

  if (!questions) return null
  const visible = questions.filter(q => !bot || q.bot === bot || q.bot == null).slice(0, 3)

  async function send(q) {
    const text = (drafts[q.id] ?? '').trim()
    if (!text) return
    setBusy(b => ({ ...b, [q.id]: true }))
    try {
      const { item } = await api.answerInterviewQuestion(q.id, text)
      setQuestions(prev => prev.filter(x => x.id !== q.id))
      onSuggested?.(item)
      showToast('נוסח מלוטש נוסף להצעות למטה — אישור אחד והוא במאגר ✓')
    } catch {
      showToast('הליטוש נכשל — התשובה שלך נשמרה, נסו שוב עוד רגע')
    } finally {
      setBusy(b => ({ ...b, [q.id]: false }))
    }
  }

  async function skip(q) {
    setQuestions(prev => prev.filter(x => x.id !== q.id))
    try { await api.dismissInterviewQuestion(q.id) } catch { /* optimistic */ }
  }

  async function generate() {
    setGenerating(true); setGenError(false)
    try {
      const { questions: fresh } = await api.generateInterviewQuestions(bot)
      if (fresh.length) setQuestions(prev => [...fresh, ...prev])
      else showToast('לא נמצאו שאלות חדשות שעוד לא כוסו — המאגר שלך מקיף 👏')
    } catch {
      setGenError(true)
    } finally {
      setGenerating(false)
    }
  }

  return (
    <section className="iv-card">
      <div className="iv-head">
        <h3>🌐 שאלות מהשטח</h3>
        <span>לקוחות שואלים את זה ברשת — ענו בשפה חופשית, ואנחנו נהפוך את זה לתשובה מוכנה במאגר</span>
      </div>

      {visible.map(q => {
        const meta = botById(bots, q.bot)
        return (
          <div key={q.id} className="iv-q">
            <div className="iv-q-text">
              {meta && !bot && <span className="fq-bot-tag" style={{ '--bot-color': meta.color }}>{meta.icon} {meta.name}</span>}
              {q.text}
            </div>
            <textarea
              rows={2}
              placeholder="ענו כאן בחופשיות — גם שורה אחת מספיקה, אנחנו כבר ננסח"
              value={drafts[q.id] ?? q.raw_answer ?? ''}
              onChange={e => setDrafts(d => ({ ...d, [q.id]: e.target.value }))}
            />
            <div className="iv-actions">
              <button className="cd-qa" onClick={() => skip(q)}>דלג</button>
              <button className="cd-qa cd-qa-primary" disabled={busy[q.id] || !(drafts[q.id] ?? '').trim()}
                      onClick={() => send(q)}>
                {busy[q.id] ? 'מנסח…' : 'שלח לניסוח ←'}
              </button>
            </div>
          </div>
        )
      })}

      {visible.length === 0 && (
        <div className="iv-empty">עניתם על כל השאלות הפתוחות{bot ? ' בזון הזה' : ''} — שלפו חדשות 👇</div>
      )}

      <button className="iv-generate" onClick={generate} disabled={generating}>
        {generating ? '✨ שולף שאלות מהרשת…' : '✨ שלפו שאלות חדשות'}
      </button>
      {genError && <div className="iv-gen-error">השליפה לא הצליחה הפעם — נסו שוב עוד רגע</div>}
    </section>
  )
}
```

- [ ] **Step 2: Render inside DemoFaq** (`FaqSettings.jsx`)

```js
import InterviewCard from './Interview.jsx'
```

As the first child of the returned `fq-page` div (before the suggested strip):

```jsx
      <InterviewCard
        api={api} bots={bots} bot={bot} showToast={showToast}
        onSuggested={item => setItems(prev => [...prev, item])}
      />
```

- [ ] **Step 3: CSS** (append to `demo.css`)

```css
/* ── Knowledge interview card ── */
.iv-card { background: linear-gradient(135deg, #f0fdfa, #fefce8); border: 1px solid #d6f5ef;
  border-radius: 16px; padding: 18px 20px; margin-bottom: 18px; display: flex; flex-direction: column; gap: 12px; }
.iv-head h3 { margin: 0 0 2px; font-size: 16px; }
.iv-head span { font-size: 13px; color: #475569; }
.iv-q { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 12px 14px;
  display: flex; flex-direction: column; gap: 8px; }
.iv-q-text { font-weight: 600; font-size: 14px; color: #0f172a; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.iv-q textarea { border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 10px; font: inherit; resize: vertical; }
.iv-actions { display: flex; gap: 8px; justify-content: flex-end; }
.iv-empty { font-size: 13.5px; color: #475569; text-align: center; padding: 6px; }
.iv-generate { align-self: center; border: 1.5px dashed #0f766e; color: #0f766e; background: transparent;
  border-radius: 999px; padding: 8px 18px; font-weight: 700; font-size: 13.5px; cursor: pointer; }
.iv-generate:hover { background: #f0fdfa; }
.iv-generate:disabled { opacity: .6; cursor: default; }
.iv-gen-error { font-size: 12.5px; color: #b45309; text-align: center; }
```

- [ ] **Step 4: Manual verification (scratch business, real server)**

On `http://localhost:5173/demo?biz=<SCRATCH_ID>` FAQ tab:
1. The card shows 3 open questions (mixed bots with tags in hub; only-hair questions in the השתלות שיער zone).
2. Answer one in casual Hebrew ("לא כואב כמעט, מרדימים מקומית, יומיים והכל רגיל") → busy state → toast → the question leaves the card and a POLISHED suggested item appears in the strip below without a refresh; its wording is brand-voice, not the raw text.
3. Approve it from the strip → lands in the bank (existing flow).
4. דלג removes a question; after refresh it stays gone (dismissed persisted).
5. "✨ שלפו שאלות חדשות" (in a bot zone) → spinner → 3–5 new natural questions appear, none duplicating existing FAQ/interview questions.
6. Kill the server, click שלח → error toast, the typed answer stays in the textarea.

- [ ] **Step 5: Commit**

```bash
git add wa-studio/src/demo/Interview.jsx wa-studio/src/demo/FaqSettings.jsx wa-studio/src/demo/demo.css
git commit -m "feat(interview): questions-from-the-field card wired into the FAQ approval flow"
```

---

### Task 12: Regression, deploy, prod seed, prod walkthrough

**Files:** none new (runs + one prod seed)

- [ ] **Step 1: Full local regression**

1. `cd server && npm test` → all pass.
2. `cd wa-studio && npm run build` → clean build; note the emitted `assets/main-<hash>.js` name for the prod check.
3. No-config regression — find a business without a `bots` config (Dragons Kids; get its full id with `curl -s http://localhost:8080/studio/rpc -H "Content-Type: application/json" -d '{"fn":"listBusinesses","args":[]}'` and pick the id whose name contains "Dragons"): open `http://localhost:5173/demo?biz=<THAT_ID>` → no switcher, no interview card (no questions seeded), everything as today.
4. Esthetic local (still unseeded): identical to prod today.

- [ ] **Step 2: Deploy**

```bash
git push origin main:agent-native
```
Verify: `curl -s https://wagent.divdev.co/health` returns the new commit sha; poll `https://wastudio.divdev.co/demo?biz=bdc47180-a3c1-47d0-9a51-fea4b2830fe2` served HTML until it references the new `main-<hash>.js` (typically ~20s).

- [ ] **Step 3: Seed Esthetic in prod**

```bash
cd server && node --env-file=.env.local scripts/seed-esthetic-multibot.mjs bdc47180-a3c1-47d0-9a51-fea4b2830fe2
```
(Local env writes to the same Supabase that prod reads — that IS the prod seed.)

- [ ] **Step 4: Prod walkthrough (the pitch dry-run)**

On `https://wastudio.divdev.co/demo?biz=bdc47180-a3c1-47d0-9a51-fea4b2830fe2`:
1. Switcher shows מרכז + 3 bots with panels; header takes the bot color per zone.
2. Overview per bot: hair-zone conversation count equals the hub donut's hair count; donut click drills in; share tile correct.
3. Inbox per bot: leads split sensibly (ד״ר רונית פלד → הכשרות וקורסים; ורד חדד → השתלות שיער); sum of three zones = hub count.
4. FAQ per bot: items filtered, משותף items everywhere.
5. Settings per bot: identity card shows; edit panel text and revert it (write path proven, state restored).
6. Interview: answer ONE question end-to-end (pick iq_trt_06 'אתם מטפלים גם בגברים?' — safe content) and approve the result into the bank. Leave both the answered question and the approved item in place — a pre-approved example makes the demo better. Then answer iq_doc_08 (the payment question) and verify the polished answer defers pricing to נועה per the no-prices guardrail; leave it in the suggestion strip UNAPPROVED — approving it live is a great meeting moment.
7. Run the generate button once in the courses zone; confirm fresh questions arrive.

- [ ] **Step 5: Update the ops docs and commit**

Add to `wa-studio/docs/demo-script-esthetic.md` a short section "רב-בוטים + שאלות מהשטח" listing: the three zones, the drill-in from the donut, the interview answer→approve moment, and the generate-live moment (5–8 lines, Hebrew, matching the file's existing style).

```bash
git add wa-studio/docs/demo-script-esthetic.md
git commit -m "docs(demo): esthetic pitch script — multibot zones + field-questions moments"
git push origin main:agent-native
```

---

## Self-Review Checklist (run after writing, before execution)

1. Spec coverage: switcher (T5), per-tab behavior (T5–T8), config + fallback (T1–T2), identity edits (T3+T8), interview storage/UI/ops (T10–T11), curated bank (T9), live generation (T10–T11), seeding+deploy+verification (T9, T12). Donut click-through (T6). Regression guard (T5 step 4, T12).
2. Cut order under deadline pressure: T1–T9 ship feature B alone; T10–T12 add feature A. The generate button (part of T10/T11) is the last thing to cut.
3. Known accepted trade-offs: `avg_reply_ms`/`contacts_*` stay business-wide in bot view; JSONB read-merge-write races accepted (single writer); client and server classification are mirrored code, not shared code (different runtimes) — keep in sync.
