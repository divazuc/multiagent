# Modules Infrastructure + Calendar Booking Module — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-client feature-module system with calendar meeting booking (Google Calendar) as module #1 — the bot offers real free slots in WhatsApp and books meetings.

**Architecture:** New `business_modules`/`module_events` tables + a code registry. Enabled modules inject context into the conversation agent's prompt pre-LLM-call; the model emits `<<ACTION:module.name{json}>>` markers that the server validates (zod) and executes deterministically. Calendar module computes slots from weekly bookable hours + per-date overrides, filtered by Google freeBusy, earliest-first.

**Tech Stack:** Node.js ESM (Express 5), zod, `node:test` runner, Google Calendar REST v3 via fetch (no googleapis dep), React (wa-studio admin UI).

**Spec:** `docs/superpowers/specs/2026-07-24-modules-calendar-design.md` — read it first.

## Global Constraints

- All server code is ESM (`type: module`), Node built-ins imported as `node:*`.
- Timezone is `Asia/Jerusalem` everywhere; slot wall-times use the codebase's existing `toLocaleString('en-US', {timeZone})` conversion trick (see `server/index.js:475`).
- Secrets are never stored plaintext: AES-256-GCM with env `MODULE_SECRETS_KEY` (base64, 32 bytes). Never log tokens. Studio ops must never return `secrets`.
- Google OAuth scopes: exactly `https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly`.
- The model never executes side effects — only the server does, after validating the requested action against the module's zod schema AND re-checking freeBusy.
- Hebrew UI strings; RTL. Commit style: `feat(modules): ...` / `test(modules): ...`, each with the standard Co-Authored-By + Claude-Session trailer used in this repo.
- Env vars available locally via `server/.env.local` (run tests plainly — unit tests must not need env or network).
- Server deploys from branch `agent-native` (kept fast-forwarded to `main`); frontend from `main`.

---

### Task 1: Foundations — DDL file, zod, test runner

**Files:**
- Create: `wa-studio/docs/sql/2026-07-24-modules.sql`
- Modify: `server/package.json` (add zod dep, real test script)

**Interfaces:**
- Produces: tables `business_modules`, `module_events` (applied manually by the user in Supabase SQL Editor — code in later tasks tolerates their absence by failing soft); `npm test` runs `node --test test/` in `server/`.

- [ ] **Step 1: Write the DDL file** `wa-studio/docs/sql/2026-07-24-modules.sql`:

```sql
-- Modules infrastructure (spec: docs/superpowers/specs/2026-07-24-modules-calendar-design.md)
-- Apply once in Supabase SQL Editor.
begin;

create table if not exists business_modules (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id),
  module_key    text not null,
  enabled       boolean not null default false,
  settings      jsonb not null default '{}',
  secrets       jsonb not null default '{}',
  status        text not null default 'disconnected',
  status_detail text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (business_id, module_key)
);

create table if not exists module_events (
  id           bigint generated always as identity primary key,
  business_id  uuid not null,
  module_key   text not null,
  event_type   text not null,
  detail       jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists module_events_biz_idx on module_events (business_id, module_key, created_at desc);

alter table business_modules enable row level security;
alter table module_events enable row level security;
revoke all on business_modules from anon, authenticated;
revoke all on module_events from anon, authenticated;

commit;
```

- [ ] **Step 2: Add zod + test script.** In `server/`: run `npm install zod`. In `server/package.json` scripts, replace the `test` line with:

```json
"test": "node --test test/"
```

- [ ] **Step 3: Smoke the runner.** Create `server/test/smoke.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
test('runner works', () => assert.equal(1 + 1, 2));
```

Run: `cd server && npm test` → Expected: `pass 1`. Delete `server/test/smoke.test.js` after it passes (real tests arrive in Task 2).

- [ ] **Step 4: Commit**

```bash
git add wa-studio/docs/sql/2026-07-24-modules.sql server/package.json server/package-lock.json
git commit -m "feat(modules): DDL for business_modules/module_events + zod + node:test runner"
```

**Tell the user:** apply `wa-studio/docs/sql/2026-07-24-modules.sql` in the Supabase SQL Editor (can be done any time before Task 10's E2E).

---

### Task 2: Secrets crypto

**Files:**
- Create: `server/lib/modules/crypto.js`
- Test: `server/test/modules-crypto.test.js`

**Interfaces:**
- Produces: `encryptSecret(plaintext: string): {iv, tag, data}` (base64 fields), `decryptSecret(box): string`, `encryptSecrets(obj): obj` / `decryptSecrets(obj): obj` (shallow: each string value en/decrypted). Reads env `MODULE_SECRETS_KEY` (base64 32B); throws `Error('MODULE_SECRETS_KEY not set')` if missing.

- [ ] **Step 1: Write the failing test** `server/test/modules-crypto.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.MODULE_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
const { encryptSecret, decryptSecret, encryptSecrets, decryptSecrets } = await import('../lib/modules/crypto.js');

test('round-trip', () => {
  const box = encryptSecret('refresh-token-שלום');
  assert.notEqual(box.data, 'refresh-token-שלום');
  assert.ok(box.iv && box.tag && box.data);
  assert.equal(decryptSecret(box), 'refresh-token-שלום');
});

test('tamper detection', () => {
  const box = encryptSecret('secret');
  const bad = { ...box, data: Buffer.from('xx' + Buffer.from(box.data, 'base64').toString('hex').slice(2), 'hex').toString('base64') };
  assert.throws(() => decryptSecret(bad));
});

test('object helpers round-trip and skip non-strings', () => {
  const enc = encryptSecrets({ refresh_token: 'rt', account_email: 'a@b.c', n: 5 });
  assert.equal(typeof enc.refresh_token, 'object');
  assert.equal(enc.n, 5);
  const dec = decryptSecrets(enc);
  assert.equal(dec.refresh_token, 'rt');
  assert.equal(dec.account_email, 'a@b.c');
});
```

- [ ] **Step 2: Run to verify it fails.** `cd server && npm test` → Expected: FAIL `Cannot find module ... crypto.js`.

- [ ] **Step 3: Implement** `server/lib/modules/crypto.js`:

```js
// Module secrets encryption at rest (spec C-04/F-04): AES-256-GCM.
// business_modules.secrets never holds plaintext.
import crypto from 'node:crypto';

function key() {
  const b64 = process.env.MODULE_SECRETS_KEY;
  if (!b64) throw new Error('MODULE_SECRETS_KEY not set');
  const k = Buffer.from(b64, 'base64');
  if (k.length !== 32) throw new Error('MODULE_SECRETS_KEY must be 32 bytes base64');
  return k;
}

export function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function decryptSecret(box) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8');
}

export function encryptSecrets(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) out[k] = typeof v === 'string' ? encryptSecret(v) : v;
  return out;
}

export function decryptSecrets(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) out[k] = v && typeof v === 'object' && v.iv ? decryptSecret(v) : v;
  return out;
}
```

- [ ] **Step 4: Run tests.** `npm test` → Expected: all PASS.
- [ ] **Step 5: Commit** — `git add server/lib/modules/crypto.js server/test/modules-crypto.test.js && git commit -m "feat(modules): AES-256-GCM secrets encryption"`

---

### Task 3: Slot engine (pure)

**Files:**
- Create: `server/lib/modules/calendar/slots.js`
- Test: `server/test/calendar-slots.test.js`

**Interfaces:**
- Produces:
  - `ilWallToUtc(dateStr:'YYYY-MM-DD', timeStr:'HH:MM'): Date` and `utcToIlWall(d: Date): Date` — Asia/Jerusalem conversions.
  - `computeSlots({ settings, busy, now, holidays }): Slot[]` where `busy` = `[{start: Date, end: Date}]` **in IL wall clock**, `now` = IL-wall Date, `holidays` = `Set<'YYYY-MM-DD'>`; `Slot = { date:'YYYY-MM-DD', from:'HH:MM', to:'HH:MM' }`, ordered earliest first.
  - `formatSlotsContext(slots, settings): string` — Hebrew prompt block incl. action instruction; empty-array → availability-empty text.
  - `WEEKDAYS = ['sun','mon','tue','wed','thu','fri','sat']`.
- Settings shape consumed (from spec 2.2): `{ duration_min, buffer_min, horizon_days, min_notice_hours, weekly: {sun:[{from,to}],...}, overrides: {'YYYY-MM-DD':[{from,to}]|[]}, jewish_holidays_closed }`.

- [ ] **Step 1: Write the failing tests** `server/test/calendar-slots.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSlots, formatSlotsContext, ilWallToUtc, utcToIlWall } from '../lib/modules/calendar/slots.js';

// Sun 2026-08-02 08:00 IL wall clock as the fixed "now" for all tests
const NOW = new Date(2026, 7, 2, 8, 0, 0);
const BASE = {
  duration_min: 30, buffer_min: 0, horizon_days: 7, min_notice_hours: 2,
  weekly: { sun: [{ from: '10:00', to: '12:00' }], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
  overrides: {}, jewish_holidays_closed: true,
};
const S = (o = {}) => ({ ...BASE, ...o });

test('generates slots inside weekly window, earliest first', () => {
  const slots = computeSlots({ settings: S(), busy: [], now: NOW, holidays: new Set() });
  assert.deepEqual(slots[0], { date: '2026-08-02', from: '10:00', to: '10:30' });
  assert.deepEqual(slots.map(s => s.from).slice(0, 4), ['10:00', '10:30', '11:00', '11:30']);
  // next sunday too (horizon 7 days)
  assert.ok(slots.some(s => s.date === '2026-08-09'));
});

test('min_notice pushes past early slots', () => {
  const slots = computeSlots({ settings: S({ min_notice_hours: 3 }), busy: [], now: NOW, holidays: new Set() });
  assert.equal(slots[0].from, '11:00'); // now 08:00 + 3h = 11:00
});

test('busy event blocks overlapping slots; touching boundaries do not block', () => {
  const busy = [{ start: new Date(2026, 7, 2, 10, 30), end: new Date(2026, 7, 2, 11, 0) }];
  const slots = computeSlots({ settings: S(), busy, now: NOW, holidays: new Set() });
  const today = slots.filter(s => s.date === '2026-08-02').map(s => s.from);
  assert.deepEqual(today, ['10:00', '11:00', '11:30']); // 10:30 blocked; 10:00 & 11:00 touch but fit
});

test('duration that no longer fits in the window rolls to the next day', () => {
  const busy = [{ start: new Date(2026, 7, 2, 10, 0), end: new Date(2026, 7, 2, 11, 45) }];
  const slots = computeSlots({ settings: S({ duration_min: 30 }), busy, now: NOW, holidays: new Set() });
  // remaining 11:45-12:00 = 15min < 30min → nothing today, first slot next Sunday
  assert.equal(slots[0].date, '2026-08-09');
});

test('buffer spaces candidates', () => {
  const slots = computeSlots({ settings: S({ buffer_min: 15 }), busy: [], now: NOW, holidays: new Set() });
  const today = slots.filter(s => s.date === '2026-08-02').map(s => s.from);
  assert.deepEqual(today, ['10:00', '10:45', '11:30']); // step 45; 11:30+30=12:00 fits exactly
});

test('per-date override replaces weekly; empty array closes the day', () => {
  const settings = S({ overrides: { '2026-08-02': [{ from: '14:00', to: '15:00' }], '2026-08-09': [] } });
  const slots = computeSlots({ settings, busy: [], now: NOW, holidays: new Set() });
  assert.equal(slots[0].from, '14:00');
  assert.ok(!slots.some(s => s.date === '2026-08-09'));
});

test('holiday closes the day when configured', () => {
  const slots = computeSlots({ settings: S(), busy: [], now: NOW, holidays: new Set(['2026-08-02']) });
  assert.ok(!slots.some(s => s.date === '2026-08-02'));
});

test('timezone helpers round-trip (IL summer = UTC+3)', () => {
  const utc = ilWallToUtc('2026-08-02', '10:00');
  assert.equal(utc.toISOString(), '2026-08-02T07:00:00.000Z');
  const wall = utcToIlWall(utc);
  assert.equal(wall.getHours(), 10);
});

test('context block is Hebrew, capped, and carries the action instruction', () => {
  const slots = computeSlots({ settings: S({ horizon_days: 14 }), busy: [], now: NOW, holidays: new Set() });
  const text = formatSlotsContext(slots, S());
  assert.ok(text.includes('<<ACTION:calendar.book'));
  assert.ok(text.includes('2026-08-02'));
  assert.ok((text.match(/\d{2}:\d{2}/g) || []).length <= 90); // capped output
});
```

- [ ] **Step 2: Run to verify failure.** `npm test` → FAIL (module not found).

- [ ] **Step 3: Implement** `server/lib/modules/calendar/slots.js`:

```js
// Pure slot computation for the calendar module. All Dates in here are
// IL WALL CLOCK (same convention as isWithinWorkingHours in index.js);
// conversion to real UTC happens only at the Google API boundary.
const IL_TZ = 'Asia/Jerusalem';
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function utcToIlWall(d) {
  return new Date(d.toLocaleString('en-US', { timeZone: IL_TZ }));
}

export function ilWallToUtc(dateStr, timeStr) {
  const naive = new Date(`${dateStr}T${timeStr}:00Z`).getTime(); // wall time pretending UTC
  const zoned = (ms) => new Date(new Date(ms).toLocaleString('en-US', { timeZone: IL_TZ })).getTime();
  let utc = naive - (zoned(naive) - naive);
  const off2 = zoned(utc) - utc;              // second pass nails DST boundaries
  if (utc + off2 !== naive) utc = naive - off2;
  return new Date(utc);
}

const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const atTime = (day, t) => { const [h, m] = t.split(':').map(Number); const d = new Date(day); d.setHours(h, m, 0, 0); return d; };

export function computeSlots({ settings, busy, now, holidays }) {
  const {
    duration_min = 30, buffer_min = 0, horizon_days = 14, min_notice_hours = 3,
    weekly = {}, overrides = {}, jewish_holidays_closed = true,
  } = settings ?? {};
  const durMs = duration_min * 60000;
  const stepMs = (duration_min + buffer_min) * 60000;
  const earliest = new Date(now.getTime() + min_notice_hours * 3600000);
  const slots = [];

  for (let dayOffset = 0; dayOffset <= horizon_days; dayOffset++) {
    const day = new Date(now); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() + dayOffset);
    const key = dateKey(day);
    if (jewish_holidays_closed && holidays?.has(key)) continue;
    const windows = key in overrides ? overrides[key] : (weekly[WEEKDAYS[day.getDay()]] ?? []);
    for (const w of windows ?? []) {
      const wStart = atTime(day, w.from).getTime();
      const wEnd = atTime(day, w.to).getTime();
      for (let start = wStart; start + durMs <= wEnd; start += stepMs) {
        const end = start + durMs;
        if (start < earliest.getTime()) continue;
        const blocked = (busy ?? []).some(b => start < b.end.getTime() && end > b.start.getTime());
        if (blocked) continue;
        slots.push({ date: key, from: hhmm(new Date(start)), to: hhmm(new Date(end)) });
      }
    }
  }
  slots.sort((a, b) => (a.date + a.from).localeCompare(b.date + b.from));
  return slots;
}

const HEB_DAYS = ['יום ראשון', 'יום שני', 'יום שלישי', 'יום רביעי', 'יום חמישי', 'יום שישי', 'שבת'];
const MAX_CONTEXT_SLOTS = 40;

export function formatSlotsContext(slots, settings) {
  if (!slots?.length) {
    return `## תיאום פגישות\nאין כרגע מועדים פנויים ביומן. אם הלקוח מבקש פגישה — בקש/י שם וטלפון והסבר/י שנציג יחזור לתאם ידנית. אין להמציא מועדים.`;
  }
  const byDay = new Map();
  for (const s of slots.slice(0, MAX_CONTEXT_SLOTS)) {
    if (!byDay.has(s.date)) byDay.set(s.date, []);
    byDay.get(s.date).push(s.from);
  }
  const lines = [...byDay.entries()].map(([date, times]) => {
    const d = new Date(`${date}T00:00:00`);
    return `- ${HEB_DAYS[d.getDay()]} ${date}: ${times.join(', ')}`;
  });
  return `## תיאום פגישות (משך פגישה: ${settings.duration_min ?? 30} דק')
מועדים פנויים אמיתיים ביומן — אלה המועדים היחידים שמותר להציע (לעולם אל תמציא/י מועד אחר):
${lines.join('\n')}
כללים: הצע/י קודם את המועד הפנוי המוקדם ביותר. אם הלקוח מבקש יום/שעה אחרים — בחר/י מהרשימה בלבד.
כאשר הלקוח אישר מועד ומסר שם, הוסף/י בסוף התשובה שורה נפרדת בפורמט המדויק:
<<ACTION:calendar.book{"slot":"YYYY-MM-DDTHH:MM","name":"שם הלקוח","phone":"טלפון אם ידוע"}>>
אל תבטיח/י שהפגישה נקבעה לפני שקיבלת אישור מועד + שם. אל תציג/י את השורה הזאת ללקוח כטקסט רגיל.`;
}
```

- [ ] **Step 4: Run tests.** `npm test` → Expected: all PASS (fix until green — the busy-overlap test and buffer test are the likely first failures).
- [ ] **Step 5: Commit** — `git commit -m "feat(calendar): pure slot engine with weekly hours, overrides, freeBusy filtering"` (add both files).

---

### Task 4: Action marker extraction

**Files:**
- Create: `server/lib/modules/actions.js`
- Test: `server/test/modules-actions.test.js`

**Interfaces:**
- Produces: `extractModuleAction(text): { text: string, action: {module, name, payload}|null }` — strips ALL markers from text, returns the FIRST parseable action; malformed JSON → `action: null` (marker still stripped).

- [ ] **Step 1: Failing tests** `server/test/modules-actions.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractModuleAction } from '../lib/modules/actions.js';

test('extracts and strips a valid action', () => {
  const r = extractModuleAction('מעולה, קבעתי לך!\n<<ACTION:calendar.book{"slot":"2026-08-02T10:00","name":"דנה"}>>');
  assert.equal(r.text, 'מעולה, קבעתי לך!');
  assert.deepEqual(r.action, { module: 'calendar', name: 'book', payload: { slot: '2026-08-02T10:00', name: 'דנה' } });
});

test('no marker → text unchanged, action null', () => {
  const r = extractModuleAction('שלום! איך אפשר לעזור?');
  assert.equal(r.text, 'שלום! איך אפשר לעזור?');
  assert.equal(r.action, null);
});

test('malformed JSON → marker stripped, action null', () => {
  const r = extractModuleAction('טקסט <<ACTION:calendar.book{"slot": nope}>> עוד');
  assert.ok(!r.text.includes('ACTION'));
  assert.equal(r.action, null);
});

test('multiple markers → first action wins, all stripped', () => {
  const r = extractModuleAction('א <<ACTION:calendar.book{"slot":"a"}>> ב <<ACTION:calendar.book{"slot":"b"}>>');
  assert.equal(r.action.payload.slot, 'a');
  assert.ok(!r.text.includes('ACTION'));
});
```

- [ ] **Step 2: Run** → FAIL (module not found).
- [ ] **Step 3: Implement** `server/lib/modules/actions.js`:

```js
// The structured-action protocol: the model REQUESTS an action inside its
// reply; the server strips the marker and decides whether to execute.
const MARKER_RE = /<<ACTION:([a-z_]+)\.([a-z_]+)(\{[\s\S]*?\})>>/g;

export function extractModuleAction(text) {
  let action = null;
  const stripped = String(text ?? '').replace(MARKER_RE, (_m, mod, name, json) => {
    if (!action) {
      try { action = { module: mod, name, payload: JSON.parse(json) }; } catch { /* malformed — strip anyway */ }
    }
    return '';
  }).replace(/[ \t]+\n/g, '\n').trim();
  return { text: stripped, action };
}
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(modules): structured action marker extraction"`.

---

### Task 5: Module engine + registry

**Files:**
- Create: `server/lib/modules/engine.js`, `server/lib/modules/registry.js`
- Test: `server/test/modules-engine.test.js`

**Interfaces:**
- Consumes: `crypto.js` (Task 2), `actions.js` (Task 4); Supabase client `server/lib/supabase.js` (existing, exports `supabase`).
- Produces (used by Tasks 6-8):
  - `registry.js`: `MODULES` — `{ [key]: def }` where `def = { key, name, settingsSchema (zod), defaultSettings, contextProvider(business, moduleRow) => Promise<string|null>, actions: { [name]: { schema (zod), handler(business, moduleRow, payload, sessionCtx) => Promise<{confirmationText?, failureText?}> } }, adminUI }`. For testability, `registry.js` also exports `_setModuleForTest(key, def)`.
  - `engine.js`:
    - `getEnabledModules(businessId): Promise<rows[]>` (row = DB row incl. settings/secrets/status)
    - `buildModulesContext(business): Promise<string|null>` — business is the row with at least `{id, name}`; concatenates non-null provider blocks; provider throw → log `context_error`, skip.
    - `executeModuleAction(business, action, sessionCtx): Promise<{text: string|null}>` — validates module enabled + action exists + zod payload; runs handler; returns confirmation/failure text; logs `action.<name>` / `action.<name>_failed`; NEVER throws.
    - `logModuleEvent(businessId, moduleKey, eventType, detail)` — fire-and-forget insert into `module_events`.

- [ ] **Step 1: Failing tests** `server/test/modules-engine.test.js` (uses a fake module + a stubbed supabase via `_setDbForTest`):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.MODULE_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
const { z } = await import('zod');
const { _setModuleForTest } = await import('../lib/modules/registry.js');
const engine = await import('../lib/modules/engine.js');

const events = [];
engine._setDbForTest({
  enabledRows: [{ business_id: 'b1', module_key: 'fake', enabled: true, settings: {}, secrets: {}, status: 'connected' }],
  onEvent: (e) => events.push(e),
});

_setModuleForTest('fake', {
  key: 'fake', name: 'Fake',
  settingsSchema: z.object({}).passthrough(), defaultSettings: {},
  contextProvider: async (biz) => `CTX for ${biz.name}`,
  actions: {
    ping: {
      schema: z.object({ msg: z.string() }),
      handler: async (_biz, _row, payload) => ({ confirmationText: `pong:${payload.msg}` }),
    },
  },
  adminUI: { fields: [] },
});

const BIZ = { id: 'b1', name: 'עסק' };

test('buildModulesContext concatenates provider output', async () => {
  const ctx = await engine.buildModulesContext(BIZ);
  assert.ok(ctx.includes('CTX for עסק'));
});

test('executeModuleAction runs a valid action and logs', async () => {
  const r = await engine.executeModuleAction(BIZ, { module: 'fake', name: 'ping', payload: { msg: 'hi' } }, {});
  assert.equal(r.text, 'pong:hi');
  assert.ok(events.some(e => e.event_type === 'action.ping'));
});

test('invalid payload → no execution, failure logged, null text', async () => {
  const r = await engine.executeModuleAction(BIZ, { module: 'fake', name: 'ping', payload: { msg: 5 } }, {});
  assert.equal(r.text, null);
  assert.ok(events.some(e => e.event_type === 'action.ping_failed'));
});

test('unknown module/action → null, never throws', async () => {
  const r1 = await engine.executeModuleAction(BIZ, { module: 'nope', name: 'x', payload: {} }, {});
  const r2 = await engine.executeModuleAction(BIZ, { module: 'fake', name: 'nope', payload: {} }, {});
  assert.equal(r1.text, null); assert.equal(r2.text, null);
});

test('provider throw → context skipped, context_error logged', async () => {
  _setModuleForTest('fake', {
    key: 'fake', name: 'Fake', settingsSchema: z.object({}).passthrough(), defaultSettings: {},
    contextProvider: async () => { throw new Error('boom'); }, actions: {}, adminUI: { fields: [] },
  });
  const ctx = await engine.buildModulesContext(BIZ);
  assert.equal(ctx, null);
  assert.ok(events.some(e => e.event_type === 'context_error'));
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `server/lib/modules/registry.js`:

```js
// Module catalog. Each module is a self-contained definition; the engine
// and admin UI consume this map — adding a module means adding an entry.
import calendarModule from './calendar/index.js';

export const MODULES = {
  [calendarModule.key]: calendarModule,
};

export function _setModuleForTest(key, def) { MODULES[key] = def; }
```

(Until Task 6 exists, create a placeholder `server/lib/modules/calendar/index.js` exporting `{ key: 'calendar', name: 'תיאום פגישות ביומן', settingsSchema: null, defaultSettings: {}, contextProvider: async () => null, actions: {}, adminUI: { fields: [] } }` — Task 6 replaces it. Import zod there only when real.)

`server/lib/modules/engine.js`:

```js
import { MODULES } from './registry.js';

let db = null; // test seam
export function _setDbForTest(fake) { db = fake; }

async function realDb() {
  const { supabase } = await import('../supabase.js');
  return {
    async loadEnabled(businessId) {
      const { data, error } = await supabase.from('business_modules')
        .select('*').eq('business_id', businessId).eq('enabled', true);
      if (error) throw error;
      return data ?? [];
    },
    async insertEvent(row) {
      await supabase.from('module_events').insert(row);
    },
  };
}

export async function getEnabledModules(businessId) {
  if (db) return db.enabledRows.filter(r => r.business_id === businessId && r.enabled);
  return (await realDb()).loadEnabled(businessId);
}

export function logModuleEvent(businessId, moduleKey, eventType, detail) {
  const row = { business_id: businessId, module_key: moduleKey, event_type: eventType, detail: detail ?? null };
  if (db) { db.onEvent?.(row); return; }
  realDb().then(d => d.insertEvent(row)).catch(e => console.error('[module_events]', e.message));
}

// Spec §3: a token failure flips the module row to status 'error' so the
// admin sees red and the agent stops offering the capability.
export function markModuleError(businessId, moduleKey, detail) {
  if (db) { db.onMarkError?.({ businessId, moduleKey, detail }); return; }
  import('../supabase.js').then(({ supabase }) =>
    supabase.from('business_modules')
      .update({ status: 'error', status_detail: String(detail).slice(0, 300), updated_at: new Date().toISOString() })
      .eq('business_id', businessId).eq('module_key', moduleKey)
  ).catch(e => console.error('[modules] markError failed:', e.message));
}

export async function buildModulesContext(business) {
  let rows;
  try { rows = await getEnabledModules(business.id); } catch (e) {
    console.error('[modules] load failed:', e.message); return null;
  }
  const blocks = [];
  for (const row of rows) {
    const def = MODULES[row.module_key];
    if (!def) continue;
    try {
      const block = await def.contextProvider(business, row);
      if (block) blocks.push(block);
    } catch (e) {
      logModuleEvent(business.id, row.module_key, 'context_error', { error: e.message });
      if (e.code === 'TOKEN_ERROR') markModuleError(business.id, row.module_key, e.message);
    }
  }
  return blocks.length ? blocks.join('\n\n') : null;
}

export async function executeModuleAction(business, action, sessionCtx) {
  if (!action) return { text: null };
  const { module: moduleKey, name, payload } = action;
  const def = MODULES[moduleKey];
  const actionDef = def?.actions?.[name];
  try {
    const rows = await getEnabledModules(business.id);
    const row = rows.find(r => r.module_key === moduleKey);
    if (!def || !actionDef || !row) return { text: null };

    const parsed = actionDef.schema.safeParse(payload);
    if (!parsed.success) {
      logModuleEvent(business.id, moduleKey, `action.${name}_failed`, { reason: 'invalid_payload', issues: parsed.error.issues });
      return { text: null };
    }
    const result = await actionDef.handler(business, row, parsed.data, sessionCtx);
    logModuleEvent(business.id, moduleKey, `action.${name}`, { payload: parsed.data, ok: !result?.failureText });
    return { text: result?.confirmationText ?? result?.failureText ?? null };
  } catch (e) {
    logModuleEvent(business.id, moduleKey, `action.${name}_failed`, { reason: 'handler_error', error: e.message });
    return { text: null };
  }
}
```

- [ ] **Step 4: Run** → PASS (all engine tests + earlier suites).
- [ ] **Step 5: Commit** — `git commit -m "feat(modules): engine + registry with audit logging"` (3 files + placeholder calendar/index.js).

---

### Task 6: Calendar module + Google/fake providers

**Files:**
- Create: `server/lib/modules/calendar/google.js`, replace placeholder `server/lib/modules/calendar/index.js`
- Test: `server/test/calendar-module.test.js`

**Interfaces:**
- Consumes: `slots.js` (Task 3), `crypto.js`, `engine.js`'s row shape, existing `sendWhatsAppMessage({to, text, businessId})` from `server/lib/wa-send.js`, `JEWISH_HOLIDAYS` — **move** the `JEWISH_HOLIDAYS` Set from `server/index.js` into a new tiny module `server/lib/holidays.js` (`export const JEWISH_HOLIDAYS = new Set([...same dates...])`) and re-import it in `index.js` (delete the inline copy).
- Produces: default export module def with `key: 'calendar'`; provider interface `{ getAuthUrl(state), exchangeCode(code), freeBusy(secrets, fromUtcISO, toUtcISO) => [{start,end} UTC ISO], createEvent(secrets, {startUtcISO, endUtcISO, title, description}) => {eventId, htmlLink} }`; `_setProviderForTest(p)` test seam. Settings schema per spec 2.2 (zod), incl. `provider: 'google'|'fake'`, `mode: 'autonomous'|'owner_confirmed'` (default `owner_confirmed`), `owner_notify_phone: string` (optional).

- [ ] **Step 1: Failing tests** `server/test/calendar-module.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.MODULE_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
const calendar = (await import('../lib/modules/calendar/index.js')).default;
const { _setProviderForTest } = await import('../lib/modules/calendar/index.js');

const created = [];
_setProviderForTest({
  freeBusy: async () => [],
  createEvent: async (_s, ev) => { created.push(ev); return { eventId: 'ev1', htmlLink: 'http://cal/ev1' }; },
});

function row(settings = {}) {
  return {
    business_id: 'b1', module_key: 'calendar', enabled: true, status: 'connected',
    secrets: {}, settings: {
      provider: 'fake', mode: 'autonomous', duration_min: 30, buffer_min: 0,
      horizon_days: 7, min_notice_hours: 0,
      weekly: { sun: [{ from: '10:00', to: '12:00' }], mon: [{ from: '10:00', to: '12:00' }], tue: [{ from: '10:00', to: '12:00' }], wed: [{ from: '10:00', to: '12:00' }], thu: [{ from: '10:00', to: '12:00' }], fri: [], sat: [] },
      overrides: {}, jewish_holidays_closed: true, event_title: 'פגישה — {name}',
      ...settings,
    },
  };
}
const BIZ = { id: 'b1', name: 'קליניקה' };

test('settings schema applies defaults and rejects bad mode', () => {
  const ok = calendar.settingsSchema.safeParse({ weekly: {} });
  assert.ok(ok.success);
  assert.equal(ok.data.mode, 'owner_confirmed');
  assert.ok(!calendar.settingsSchema.safeParse({ mode: 'yolo' }).success);
});

test('contextProvider returns a Hebrew slots block', async () => {
  const ctx = await calendar.contextProvider(BIZ, row());
  assert.ok(ctx.includes('תיאום פגישות'));
  assert.ok(ctx.includes('<<ACTION:calendar.book'));
});

test('book action creates an event and confirms (autonomous)', async () => {
  const slots = await calendar._computeCurrentSlots(row());
  const slot = `${slots[0].date}T${slots[0].from}`;
  const r = await calendar.actions.book.handler(BIZ, row(), { slot, name: 'דנה', phone: '0501234567' }, { session_id: '0501234567' });
  assert.ok(r.confirmationText.includes('נקבעה'));
  assert.equal(created.length, 1);
  assert.ok(created[0].title.includes('דנה'));
});

test('slot not on the list → failure text with alternatives, no event', async () => {
  created.length = 0;
  const r = await calendar.actions.book.handler(BIZ, row(), { slot: '2030-01-01T03:00', name: 'דנה' }, {});
  assert.ok(r.failureText);
  assert.equal(created.length, 0);
});

test('race: slot busy on re-check → failure text, no event', async () => {
  created.length = 0;
  const slots = await calendar._computeCurrentSlots(row());
  const slot = `${slots[0].date}T${slots[0].from}`;
  // Wide (horizon) freeBusy query → free; narrow (single-slot re-check) → busy.
  // This makes the slot pass the list check but fail the race re-check.
  _setProviderForTest({
    freeBusy: async (_s, from, to) =>
      (new Date(to) - new Date(from) <= 3600000) ? [{ start: from, end: to }] : [],
    createEvent: async () => { throw new Error('must not be called'); },
  });
  const r = await calendar.actions.book.handler(BIZ, row(), { slot, name: 'דנה' }, {});
  assert.ok(r.failureText.includes('נתפס'));
  assert.equal(created.length, 0);
});

test('owner_confirmed creates tentative title', async () => {
  _setProviderForTest({
    freeBusy: async () => [],
    createEvent: async (_s, ev) => { created.push(ev); return { eventId: 'ev2', htmlLink: '' }; },
  });
  created.length = 0;
  const r = row({ mode: 'owner_confirmed' });
  const slots = await calendar._computeCurrentSlots(r);
  const res = await calendar.actions.book.handler(BIZ, r, { slot: `${slots[0].date}T${slots[0].from}`, name: 'דנה' }, {});
  assert.ok(created[0].title.startsWith('⏳ ממתין לאישור'));
  assert.ok(res.confirmationText);
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** First `server/lib/holidays.js` (move the existing `JEWISH_HOLIDAYS` Set verbatim from `server/index.js:463+`, export it, and change `index.js` to `import { JEWISH_HOLIDAYS } from './lib/holidays.js';`).

`server/lib/modules/calendar/google.js`:

```js
// Google Calendar REST v3 — no googleapis dep, plain fetch.
// secrets shape (decrypted): { refresh_token, account_email }
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
export const SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly';

const accessCache = new Map(); // refresh_token -> {token, exp}

export function getAuthUrl(state) {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${process.env.PUBLIC_BASE_URL ?? 'https://wagent.divdev.co'}/oauth/google/callback`,
    response_type: 'code', scope: SCOPES, access_type: 'offline', prompt: 'consent', state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function exchangeCode(code) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${process.env.PUBLIC_BASE_URL ?? 'https://wagent.divdev.co'}/oauth/google/callback`,
      grant_type: 'authorization_code',
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.refresh_token) throw new Error(`token exchange failed: ${body.error ?? res.status}`);
  let email = '';
  try {
    const info = await (await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${body.access_token}` } })).json();
    email = info.email ?? '';
  } catch { /* email is cosmetic */ }
  return { refresh_token: body.refresh_token, account_email: email };
}

async function accessToken(secrets) {
  const cached = accessCache.get(secrets.refresh_token);
  if (cached && cached.exp > Date.now()) return cached.token;
  const res = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: secrets.refresh_token, client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token',
    }),
  });
  const body = await res.json();
  if (!res.ok) { const e = new Error(`TOKEN_ERROR: ${body.error ?? res.status}`); e.code = 'TOKEN_ERROR'; throw e; }
  accessCache.set(secrets.refresh_token, { token: body.access_token, exp: Date.now() + (body.expires_in - 60) * 1000 });
  return body.access_token;
}

export async function freeBusy(secrets, fromUtcISO, toUtcISO) {
  const token = await accessToken(secrets);
  const res = await fetch(`${API}/freeBusy`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeMin: fromUtcISO, timeMax: toUtcISO, items: [{ id: 'primary' }] }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`freeBusy failed: ${body.error?.message ?? res.status}`);
  return (body.calendars?.primary?.busy ?? []).map(b => ({ start: b.start, end: b.end }));
}

export async function createEvent(secrets, { startUtcISO, endUtcISO, title, description }) {
  const token = await accessToken(secrets);
  const res = await fetch(`${API}/calendars/primary/events`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: title, description,
      start: { dateTime: startUtcISO }, end: { dateTime: endUtcISO },
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`createEvent failed: ${body.error?.message ?? res.status}`);
  return { eventId: body.id, htmlLink: body.htmlLink ?? '' };
}
```

`server/lib/modules/calendar/index.js` (replaces placeholder):

```js
import { z } from 'zod';
import * as google from './google.js';
import { computeSlots, formatSlotsContext, ilWallToUtc, utcToIlWall, WEEKDAYS } from './slots.js';
import { decryptSecrets } from '../crypto.js';
import { JEWISH_HOLIDAYS } from '../../holidays.js';

const windowSchema = z.object({ from: z.string().regex(/^\d{2}:\d{2}$/), to: z.string().regex(/^\d{2}:\d{2}$/) });
const weeklyDefault = Object.fromEntries(WEEKDAYS.map(d => [d, []]));

const settingsSchema = z.object({
  provider: z.enum(['google', 'fake']).default('google'),
  mode: z.enum(['autonomous', 'owner_confirmed']).default('owner_confirmed'),
  duration_min: z.number().int().min(10).max(240).default(30),
  buffer_min: z.number().int().min(0).max(120).default(0),
  horizon_days: z.number().int().min(1).max(60).default(14),
  min_notice_hours: z.number().min(0).max(168).default(3),
  weekly: z.record(z.string(), z.array(windowSchema)).default(weeklyDefault),
  overrides: z.record(z.string(), z.array(windowSchema)).default({}),
  jewish_holidays_closed: z.boolean().default(true),
  event_title: z.string().default('פגישה — {name}'),
  owner_notify_phone: z.string().optional(),
});

let testProvider = null;
export function _setProviderForTest(p) { testProvider = p; }
function provider(settings) {
  if (settings.provider === 'fake') {
    // Test seam + no-Google E2E mode: busy list from env, events to the log.
    return testProvider ?? {
      freeBusy: async () => JSON.parse(process.env.CALENDAR_FAKE_BUSY ?? '[]'),
      createEvent: async (_s, ev) => { console.log('[calendar-fake] createEvent', ev.title, ev.startUtcISO); return { eventId: 'fake', htmlLink: '' }; },
    };
  }
  return google;
}

function nowIl() { return utcToIlWall(new Date()); }

async function busyWall(row, settings) {
  const secrets = decryptSecrets(row.secrets);
  const now = nowIl();
  const to = new Date(now); to.setDate(to.getDate() + settings.horizon_days + 1);
  const fromUtc = new Date().toISOString();
  const toUtc = ilWallToUtc(`${to.getFullYear()}-${String(to.getMonth() + 1).padStart(2, '0')}-${String(to.getDate()).padStart(2, '0')}`, '23:59').toISOString();
  const busy = await provider(settings).freeBusy(secrets, fromUtc, toUtc);
  return busy.map(b => ({ start: utcToIlWall(new Date(b.start)), end: utcToIlWall(new Date(b.end)) }));
}

async function computeCurrentSlots(row) {
  const settings = settingsSchema.parse(row.settings ?? {});
  const busy = await busyWall(row, settings);
  return computeSlots({ settings, busy, now: nowIl(), holidays: JEWISH_HOLIDAYS });
}

const HEB_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

const calendarModule = {
  key: 'calendar',
  name: 'תיאום פגישות ביומן',
  portalVisible: false, // v1: not shown in the client portal
  settingsSchema,
  defaultSettings: settingsSchema.parse({}),
  _computeCurrentSlots: computeCurrentSlots,

  async contextProvider(_business, row) {
    if (row.status !== 'connected' && row.settings?.provider !== 'fake') return null;
    const settings = settingsSchema.parse(row.settings ?? {});
    const slots = await computeCurrentSlots(row);
    return formatSlotsContext(slots, settings);
  },

  actions: {
    book: {
      schema: z.object({
        slot: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
        name: z.string().min(1),
        phone: z.string().optional(),
      }),
      async handler(business, row, payload, sessionCtx) {
        const settings = settingsSchema.parse(row.settings ?? {});
        const [date, from] = payload.slot.split('T');

        // 1. Requested slot must be on the CURRENT computed list
        const slots = await computeCurrentSlots(row);
        const match = slots.find(s => s.date === date && s.from === from);
        const alternatives = (list) => list.slice(0, 2)
          .map(s => `${HEB_DAYS[new Date(`${s.date}T00:00:00`).getDay()]} ${s.date} בשעה ${s.from}`).join(' או ');
        if (!match) {
          return { failureText: slots.length
            ? `המועד הזה כבר לא זמין 😕 אפשר במקום: ${alternatives(slots)}?`
            : 'המועד הזה כבר לא זמין וכרגע אין מועדים פנויים — נציג יחזור אליך לתיאום.' };
        }

        // 2. Race protection — re-verify this exact range against the live calendar
        const startUtc = ilWallToUtc(date, from);
        const endUtc = ilWallToUtc(date, match.to);
        const secrets = decryptSecrets(row.secrets);
        const busyNow = await provider(settings).freeBusy(secrets, startUtc.toISOString(), endUtc.toISOString());
        if (busyNow.length) {
          const fresh = slots.filter(s => !(s.date === date && s.from === from));
          return { failureText: `אוי, המועד הזה בדיוק נתפס 😅 אפשר במקום: ${alternatives(fresh)}?` };
        }

        // 3. Create the event
        const phone = payload.phone || sessionCtx?.session_id || '';
        const tentative = settings.mode === 'owner_confirmed';
        const title = (tentative ? '⏳ ממתין לאישור: ' : '') + settings.event_title.replace('{name}', payload.name);
        await provider(settings).createEvent(secrets, {
          startUtcISO: startUtc.toISOString(), endUtcISO: endUtc.toISOString(),
          title,
          description: `נקבע ע"י הסוכן בוואטסאפ.\nשם: ${payload.name}\nטלפון: ${phone}\nעסק: ${business.name}`,
        });

        // 4. Owner notification (owner_confirmed) — non-blocking
        if (tentative && settings.owner_notify_phone) {
          import('../../wa-send.js').then(({ sendWhatsAppMessage }) =>
            sendWhatsAppMessage({
              to: settings.owner_notify_phone,
              text: `📅 בקשת פגישה חדשה: ${payload.name} (${phone}) — ${date} בשעה ${from}. האירוע ביומן מסומן "ממתין לאישור".`,
              businessId: business.id,
            })).catch(() => {});
        }

        const dayName = HEB_DAYS[new Date(`${date}T00:00:00`).getDay()];
        return { confirmationText: tentative
          ? `רשמתי בקשה לפגישה ביום ${dayName} ${date} בשעה ${from} — נאשר לך סופית בהקדם 🙏`
          : `הפגישה נקבעה! 🎉 יום ${dayName} ${date} בשעה ${from}. נתראה!` };
      },
    },
  },

  adminUI: {
    connectType: 'google_oauth',
    fields: ['mode', 'duration_min', 'buffer_min', 'min_notice_hours', 'horizon_days', 'weekly', 'jewish_holidays_closed', 'owner_notify_phone'],
  },
};

export default calendarModule;
```

- [ ] **Step 4: Run** → all suites PASS. Note: the race test relies on `provider(settings)` returning the test provider for `provider: 'fake'` — the fake path never touches the network.
- [ ] **Step 5: Commit** — `git commit -m "feat(calendar): calendar module - google provider, book action, owner-confirmed mode"` (calendar files + holidays.js + index.js import swap).

---

### Task 7: Agent integration (conversation.js + pipeline)

**Files:**
- Modify: `server/agents/conversation.js` (context block into prompts; extract action pre-validation)
- Modify: `server/index.js` (build modules context; execute action post-agent)
- Test: `server/test/conversation-modules.test.js` (extraction placement only — pure part)

**Interfaces:**
- Consumes: `extractModuleAction` (Task 4), `buildModulesContext`/`executeModuleAction` (Task 5).
- Produces: `runConversation` result gains `module_action: {module,name,payload}|null`; `context.modules_context: string|null` is consumed by the three generate* prompts.

- [ ] **Step 1: conversation.js changes.** Add import at top:

```js
import { extractModuleAction } from '../lib/modules/actions.js';
```

In `runConversation`, immediately after the `candidate = await generate...` if/else block (line ~49), replace the direct validation with:

```js
    // Modules: the model may append an ACTION marker — extract it BEFORE
    // validation so the rewrite loop never sees or mangles the marker.
    const extracted = extractModuleAction(candidate);
    candidate = extracted.text;

    // ── Step 3: Validate + rewrite loop ───────────────────────────────────────
    const validated = await validateAndFix({ candidate, persona, guardrails, intent, agent_mode });
```

(`let candidate` is already `let`.) Add `module_action: extracted.action` to the success `ok({...})` payload (the one at line ~70). In each of `generateSalesResponse`, `generateSupportResponse`, `generateHybridResponse`: add `modules_context` to the destructured params, pass it from the call sites in `runConversation` as `modules_context: context.modules_context`, and add this line into each system template immediately after the `${GROUNDING_RULE}` line:

```
${modules_context ? '\n' + modules_context + '\n' : ''}
```

- [ ] **Step 2: index.js changes.** Add import near the other lib imports:

```js
import { buildModulesContext, executeModuleAction } from './lib/modules/engine.js';
```

In `runAgentPipeline`, right after the activation pre-checks block closes (after line ~250, still inside `if (session_mode === 'live' && business_id)` scope — place it as a new block just before `// Step 3 — Route by session mode`):

```js
    // Step 2c — Modules context (live mode only, non-fatal)
    if (session_mode === 'live' && business_id) {
      try {
        context.modules_context = await buildModulesContext({ id: business_id, name: context.business_profile?.business_name ?? '' });
      } catch (e) { console.error('[modules] context failed:', e.message); }
    }
```

After `const final_response = ...` (line ~284) add:

```js
    // Execute a module action the model requested (live mode only)
    let moduleText = null;
    if (session_mode === 'live' && business_id && r?.module_action) {
      const exec = await executeModuleAction(
        { id: business_id, name: context.business_profile?.business_name ?? '' },
        r.module_action,
        { session_id },
      );
      moduleText = exec.text;
    }
    const outbound_response = moduleText ? `${final_response}\n${moduleText}`.trim() : final_response;
```

Then replace the three uses of `final_response` in the live-mode persistence block (saveConversation's `agent_response`, the `sendWhatsAppMessage` text, and the `checkAndSuggestFaq` answer) with `outbound_response`, and the returned body for live mode (`message`) likewise. In upsertContact's status line, extend:

```js
      const _contactStatus = (r?.module_action?.module === 'calendar' && moduleText && !moduleText.includes('נתפס') && !moduleText.includes('לא זמין'))
        ? 'meeting_booked'
        : r?.cta_triggered ? 'cta_triggered' : 'in_conversation';
```

And in `upsertContact` itself add `'meeting_booked'` to the ladder after `'cta_triggered'`:

```js
      const statusOrder = ['new_lead','in_conversation','cta_triggered','meeting_booked','followup_sent','converted','cold','not_relevant'];
```

- [ ] **Step 3: Regression test** `server/test/conversation-modules.test.js` (guards the marker-before-validation ordering):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('conversation.js extracts the action before validateAndFix', () => {
  const src = fs.readFileSync(new URL('../agents/conversation.js', import.meta.url), 'utf8');
  const extractIdx = src.indexOf('extractModuleAction(candidate)');
  const validateIdx = src.indexOf('validateAndFix({ candidate');
  assert.ok(extractIdx > -1 && validateIdx > -1 && extractIdx < validateIdx);
});

test('all three mode prompts include modules_context', () => {
  const src = fs.readFileSync(new URL('../agents/conversation.js', import.meta.url), 'utf8');
  assert.equal((src.match(/modules_context \? /g) || []).length, 3);
});
```

- [ ] **Step 4: Run** `npm test` → PASS; then boot the server locally (`npm run dev`) → no startup errors, `/health` 200.
- [ ] **Step 5: Commit** — `git commit -m "feat(modules): inject module context into agent prompts, execute requested actions server-side"`.

---

### Task 8: OAuth routes + studio ops + frontend status wiring

**Files:**
- Create: `server/routes/oauth.js`
- Modify: `server/lib/auth.js` (public prefix), `server/index.js` (mount router), `server/lib/studio.js` (3 ops), `wa-studio/src/lib/supabase.js` (3 client fns)

**Interfaces:**
- Consumes: `google.getAuthUrl/exchangeCode` (Task 6), `encryptSecrets` (Task 2), `PORTAL_TOKEN_SECRET` env (exists on Railway).
- Produces: `GET /oauth/google/start?state=`, `GET /oauth/google/callback`; studio ops `getModules(businessId)`, `updateModule(businessId, moduleKey, {enabled, settings})`, `createConnectLink(businessId, moduleKey)`; frontend `getModules/updateModule/createConnectLink` exports.

- [ ] **Step 1: State signing + routes** `server/routes/oauth.js`:

```js
// Google OAuth connect flow. The link is opened by the CLIENT (not the
// admin), so these routes are public — safety comes from the HMAC state.
import { Router } from 'express';
import crypto from 'node:crypto';
import { getAuthUrl, exchangeCode } from '../lib/modules/calendar/google.js';
import { encryptSecrets } from '../lib/modules/crypto.js';

const router = Router();
const SECRET = () => process.env.PORTAL_TOKEN_SECRET ?? '';

export function signConnectState(businessId, moduleKey) {
  const payload = Buffer.from(JSON.stringify({ b: businessId, m: moduleKey, e: Date.now() + 48 * 3600 * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyConnectState(state) {
  const [payload, sig] = String(state ?? '').split('.');
  if (!payload || !sig) return null;
  const expect = crypto.createHmac('sha256', SECRET()).update(payload).digest('base64url');
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (data.e < Date.now()) return null;
  return { businessId: data.b, moduleKey: data.m };
}

const page = (title, body) => `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f4f6fb}div{background:#fff;padding:32px 40px;border-radius:12px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}</style></head><body><div><h2>${title}</h2><p>${body}</p></div></body></html>`;

router.get('/oauth/google/start', (req, res) => {
  const st = verifyConnectState(req.query.state);
  if (!st) return res.status(400).send(page('קישור לא תקין', 'הקישור פג תוקף או שגוי — בקשו קישור חדש.'));
  res.redirect(getAuthUrl(req.query.state));
});

router.get('/oauth/google/callback', async (req, res) => {
  const st = verifyConnectState(req.query.state);
  if (!st) return res.status(400).send(page('קישור לא תקין', 'הקישור פג תוקף או שגוי — בקשו קישור חדש.'));
  if (req.query.error) return res.status(400).send(page('החיבור בוטל', 'אפשר לסגור את החלון ולנסות שוב.'));
  try {
    const tokens = await exchangeCode(req.query.code);
    const { supabase } = await import('../lib/supabase.js');
    const { error } = await supabase.from('business_modules').upsert({
      business_id: st.businessId, module_key: st.moduleKey,
      secrets: encryptSecrets(tokens), status: 'connected', status_detail: tokens.account_email,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'business_id,module_key' });
    if (error) throw error;
    const { logModuleEvent } = await import('../lib/modules/engine.js');
    logModuleEvent(st.businessId, st.moduleKey, 'connect', { email: tokens.account_email });
    res.send(page('היומן חובר בהצלחה ✅', 'אפשר לסגור את החלון.'));
  } catch (e) {
    console.error('[oauth]', e.message);
    res.status(500).send(page('החיבור נכשל', 'משהו השתבש — נסו שוב או פנו אלינו.'));
  }
});

export default router;
```

- [ ] **Step 2: Wire in.** `server/lib/auth.js`: `const PUBLIC_PREFIXES = ['/portal/', '/oauth/'];`. `server/index.js`: `import oauthRouter from './routes/oauth.js';` + `app.use(oauthRouter);` next to `dataRouter`.

- [ ] **Step 3: Studio ops.** In `server/lib/studio.js` add to `ops` (before the closing of the ops object):

```js
  // ── Modules ────────────────────────────────────────────────────────────────
  async getModules(businessId) {
    const { MODULES } = await import('./modules/registry.js');
    const { data, error } = await supabase.from('business_modules')
      .select('module_key, enabled, settings, status, status_detail, updated_at')
      .eq('business_id', businessId);
    if (error) throw error;
    const rows = data ?? [];
    return Object.values(MODULES).map(def => {
      const row = rows.find(r => r.module_key === def.key);
      return {
        key: def.key, name: def.name, adminUI: def.adminUI,
        enabled: row?.enabled ?? false,
        settings: { ...def.defaultSettings, ...(row?.settings ?? {}) },
        status: row?.status ?? 'disconnected', status_detail: row?.status_detail ?? null,
      };
    });
  },

  async updateModule(businessId, moduleKey, { enabled, settings } = {}) {
    const { MODULES } = await import('./modules/registry.js');
    const def = MODULES[moduleKey];
    if (!def) { const e = new Error('unknown module'); e.status = 400; throw e; }
    const parsed = def.settingsSchema.safeParse(settings ?? {});
    if (!parsed.success) { const e = new Error('invalid settings: ' + parsed.error.issues.map(i => i.path.join('.') + ' ' + i.message).join('; ')); e.status = 400; throw e; }
    const { error } = await supabase.from('business_modules').upsert({
      business_id: businessId, module_key: moduleKey,
      enabled: !!enabled, settings: parsed.data, updated_at: new Date().toISOString(),
    }, { onConflict: 'business_id,module_key' });
    if (error) throw error;
    const { logModuleEvent } = await import('./modules/engine.js');
    logModuleEvent(businessId, moduleKey, enabled ? 'enabled' : 'disabled', null);
  },

  async createConnectLink(businessId, moduleKey) {
    const { signConnectState } = await import('../routes/oauth.js');
    const base = process.env.PUBLIC_BASE_URL ?? 'https://wagent.divdev.co';
    return { url: `${base}/oauth/google/start?state=${signConnectState(businessId, moduleKey)}` };
  },
```

- [ ] **Step 4: Frontend client fns.** In `wa-studio/src/lib/supabase.js` append:

```js
// ── Modules ─────────────────────────────────────────────────────────────────

export async function getModules(businessId) {
  return (await rpc('getModules', businessId)) || []
}

export async function updateModule(businessId, moduleKey, payload) {
  await rpc('updateModule', businessId, moduleKey, payload)
}

export async function createConnectLink(businessId, moduleKey) {
  return rpc('createConnectLink', businessId, moduleKey)
}
```

- [ ] **Step 5: Local smoke.** Start server with `.env.local` + `STUDIO_AUTH_REQUIRED` unset. `curl -X POST localhost:8080/studio/rpc -H 'Content-Type: application/json' -d '{"fn":"getModules","args":["<any-business-id>"]}'` → Expected: JSON array with the calendar module, `enabled:false`, default settings. `curl "localhost:8080/oauth/google/start?state=garbage"` → Expected: 400 Hebrew error page.
- [ ] **Step 6: Commit** — `git commit -m "feat(modules): oauth connect routes + studio ops (getModules/updateModule/createConnectLink)"`.

---

### Task 9: Admin UI — ModulesSection in BotPolicyEditor

**Files:**
- Create: `wa-studio/src/components/ModulesSection.jsx`
- Modify: `wa-studio/src/components/BotPolicyEditor.jsx` (render the section at the bottom, above the save button)

**Interfaces:**
- Consumes: `getModules/updateModule/createConnectLink` from `../lib/supabase.js` (Task 8). Self-contained state + its own save (does NOT ride BotPolicyEditor's `save()`).

- [ ] **Step 1: Component** `wa-studio/src/components/ModulesSection.jsx`:

```jsx
import { useState, useEffect } from 'react'
import { getModules, updateModule, createConnectLink } from '../lib/supabase.js'

const DAY_LABELS = { sun: 'א׳', mon: 'ב׳', tue: 'ג׳', wed: 'ד׳', thu: 'ה׳', fri: 'ו׳', sat: 'ש׳' }
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const st = {
  card: { border: '1px solid var(--border)', borderRadius: 10, padding: 14, marginTop: 10, background: 'var(--surface-2)' },
  row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  dot: (c) => ({ width: 10, height: 10, borderRadius: 5, background: c, display: 'inline-block' }),
  num: { width: 64, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' },
  time: { padding: '5px 6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' },
  btn: { padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer' },
  label: { fontSize: 12, color: 'var(--text-muted)' },
}

function CalendarSettings({ mod, onChange }) {
  const s = mod.settings
  const set = (patch) => onChange({ ...s, ...patch })
  const setDay = (day, windows) => set({ weekly: { ...s.weekly, [day]: windows } })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
      <div style={st.row}>
        <span style={st.label}>מצב קביעה:</span>
        <select value={s.mode} onChange={e => set({ mode: e.target.value })} style={st.time}>
          <option value="owner_confirmed">באישור בעל העסק</option>
          <option value="autonomous">אוטונומי — הבוט קובע</option>
        </select>
        <span style={st.label}>משך (דק'):</span>
        <input type="number" style={st.num} value={s.duration_min} onChange={e => set({ duration_min: +e.target.value })} />
        <span style={st.label}>מרווח (דק'):</span>
        <input type="number" style={st.num} value={s.buffer_min} onChange={e => set({ buffer_min: +e.target.value })} />
        <span style={st.label}>התראה מראש (שעות):</span>
        <input type="number" style={st.num} value={s.min_notice_hours} onChange={e => set({ min_notice_hours: +e.target.value })} />
      </div>
      <div>
        <div style={{ ...st.label, marginBottom: 6 }}>שעות פנויות לפגישות (שונה משעות המענה של הבוט):</div>
        {DAYS.map(day => {
          const w = s.weekly?.[day] ?? []
          const first = w[0]
          return (
            <div key={day} style={{ ...st.row, marginBottom: 4 }}>
              <span style={{ width: 20 }}>{DAY_LABELS[day]}</span>
              <input type="checkbox" checked={!!first} onChange={e => setDay(day, e.target.checked ? [{ from: '09:00', to: '17:00' }] : [])} />
              {first && (<>
                <input type="time" style={st.time} value={first.from} onChange={e => setDay(day, [{ ...first, from: e.target.value }])} />
                <span>–</span>
                <input type="time" style={st.time} value={first.to} onChange={e => setDay(day, [{ ...first, to: e.target.value }])} />
              </>)}
            </div>
          )
        })}
      </div>
      <div style={st.row}>
        <label style={st.label}>
          <input type="checkbox" checked={s.jewish_holidays_closed} onChange={e => set({ jewish_holidays_closed: e.target.checked })} /> סגור בחגים
        </label>
        <span style={st.label}>טלפון בעל העסק להתראות:</span>
        <input style={{ ...st.num, width: 130 }} value={s.owner_notify_phone ?? ''} placeholder="9725..." onChange={e => set({ owner_notify_phone: e.target.value })} />
      </div>
    </div>
  )
}

export default function ModulesSection({ business }) {
  const [mods, setMods] = useState(null)
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState(null)
  const [msg, setMsg] = useState(null)

  useEffect(() => { getModules(business.id).then(setMods).catch(e => setMsg(e.message)) }, [business.id])
  if (!mods) return <div style={st.label}>טוען מודולים…</div>

  const patch = (key, p) => setMods(mods.map(m => m.key === key ? { ...m, ...p } : m))

  async function save(mod) {
    setBusy(true); setMsg(null)
    try {
      await updateModule(business.id, mod.key, { enabled: mod.enabled, settings: mod.settings })
      setMsg('נשמר ✓')
    } catch (e) { setMsg(e.message) } finally { setBusy(false) }
  }

  async function connect(mod) {
    setBusy(true)
    try { setLink((await createConnectLink(business.id, mod.key)).url) }
    catch (e) { setMsg(e.message) } finally { setBusy(false) }
  }

  const statusColor = { connected: '#22c55e', error: '#ef4444', disconnected: '#94a3b8' }

  return (
    <div style={{ marginTop: 18 }}>
      <h3 style={{ margin: '0 0 4px' }}>מודולים</h3>
      {mods.map(mod => (
        <div key={mod.key} style={st.card}>
          <div style={st.row}>
            <span style={st.dot(statusColor[mod.status] ?? '#94a3b8')} />
            <strong>{mod.name}</strong>
            <label style={{ marginInlineStart: 'auto' }}>
              <input type="checkbox" checked={mod.enabled} onChange={e => patch(mod.key, { enabled: e.target.checked })} /> פעיל
            </label>
          </div>
          {mod.status === 'connected' && mod.status_detail && <div style={st.label}>מחובר: {mod.status_detail}</div>}
          {mod.key === 'calendar' && (
            <CalendarSettings mod={mod} onChange={(settings) => patch(mod.key, { settings })} />
          )}
          <div style={{ ...st.row, marginTop: 10 }}>
            <button style={st.btn} disabled={busy} onClick={() => save(mod)}>שמירת מודול</button>
            {mod.adminUI?.connectType === 'google_oauth' && (
              <button style={st.btn} disabled={busy} onClick={() => connect(mod)}>צור קישור חיבור יומן</button>
            )}
          </div>
          {link && (
            <div style={{ marginTop: 8 }}>
              <input readOnly value={link} style={{ width: '100%', ...st.time }} onFocus={e => e.target.select()} />
              <div style={st.label}>שלחו את הקישור ללקוח — הוא מאשר עם חשבון Google שלו (תקף 48 שעות).</div>
            </div>
          )}
        </div>
      ))}
      {msg && <div style={{ ...st.label, marginTop: 6 }}>{msg}</div>}
    </div>
  )
}
```

- [ ] **Step 2: Wire into BotPolicyEditor.** In `wa-studio/src/components/BotPolicyEditor.jsx`: `import ModulesSection from './ModulesSection.jsx'` and render `<ModulesSection business={business} />` immediately before the row containing the "שמירת מדיניות" button (line ~255).

- [ ] **Step 3: Build + eyeball.** `cd wa-studio && npm run build` → clean build. `npm run dev` + open the Studio → AdminPanel → ⚙️ on a business → modules section renders, toggle + fields editable, save writes (check Network tab: `updateModule`), connect button returns a URL.
- [ ] **Step 4: Commit** — `git commit -m "feat(studio): modules admin section - calendar settings + connect link"`.

---

### Task 10: E2E with fake provider + rollout

**Files:**
- Create: `server/scripts/e2e-calendar.md` (runbook, content below)

**Interfaces:** none new — exercises everything.

- [ ] **Step 1: Precondition.** Confirm with the user that `2026-07-24-modules.sql` was applied (Task 1). If not, wait — everything below needs the tables.

- [ ] **Step 2: Seed a fake-provider module on a test business.** Via local server + curl (studio rpc `updateModule`), on an existing `is_test` business: `settings: { provider: 'fake', mode: 'autonomous', min_notice_hours: 0, weekly: { sun..thu: [{from:'10:00',to:'16:00'}], fri: [], sat: [] } }`, `enabled: true`. The `'fake'` provider (built into Task 6's `provider()`) reads busy ranges from env `CALENDAR_FAKE_BUSY` (JSON, default `[]`) and logs createEvent calls instead of hitting Google — the full chat flow runs with zero Google dependency. `contextProvider` skips the `connected` status check for `provider:'fake'`.

- [ ] **Step 3: Chat E2E via /wa-inbound (studio direct format).** Send a Hebrew message asking to book ("אפשר לקבוע פגישה?") → reply must offer the earliest real slots. Reply choosing a slot + name → reply must confirm, server log shows `[calendar-fake] createEvent`, and `module_events` has `action.book`. Verify the contact's status is `meeting_booked`.
- [ ] **Step 4: Failure paths.** Set `CALENDAR_FAKE_BUSY` to cover the offered slot, restart, book again → "בדיוק נתפס" + alternatives, no createEvent log. Disable the module (`enabled:false`) → context gone from replies.
- [ ] **Step 5: Write the runbook** `server/scripts/e2e-calendar.md` documenting steps 2-4 with the exact curl commands used (fill in real ids from the run).
- [ ] **Step 6: Full test suite + deploy.** `cd server && npm test` all green; `cd wa-studio && npm run build` clean. Push `main`, fast-forward `agent-native`, push. Set `MODULE_SECRETS_KEY` on Railway (`railway variables --set` — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`). `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`PUBLIC_BASE_URL` set once the user delivers the OAuth client.
- [ ] **Step 7: Commit runbook + update the Obsidian vault** (journal entry, roadmap: modules infra shipped; calendar awaiting Google creds + real-account E2E).

---

## Post-plan (blocked on the user)

- Google OAuth client (user is creating it) → set Railway envs → real-account E2E: connect link → consent → live freeBusy/createEvent against a real calendar → then enable for דיוה אוסט as pilot.
- Outlook provider — future plan, interface already fixed.
