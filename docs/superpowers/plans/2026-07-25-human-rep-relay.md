# Human-Rep Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the bot escalates, WhatsApp a configured human, relay their answer back to the lead in the bot's voice, and continue the conversation — instead of today's dead-end sentence that notifies nobody.

**Architecture:** A new `escalations` table tracks each open question. A new role-based `business_contacts` table holds the owner and the rep. Pure resolver modules (correlation, stop detection, phone normalisation) are unit-tested in isolation; thin store modules wrap Supabase behind a `_setDbForTest` seam, exactly as `server/lib/modules/engine.js` and `server/agents/demo.js` already do. Inbound messages from a listed contact are intercepted in the webhook before the conversation agent ever runs.

**Tech Stack:** Node 20 + Express 5 (ESM), Supabase JS, `node:test` + `node:assert/strict`, React 18 (wa-studio), WhatsApp Cloud API v21.

## Global Constraints

- **Terminology, in code and copy:** *client* / *owner* = the business owner who buys the bot. *lead* = the person messaging over WhatsApp. *rep* = whoever answers escalations. Never call a lead "the client".
- **Everything fails soft.** A relay failure must never break a reply. Follow the module engine's posture (`server/lib/modules/engine.js:46-64`).
- **Never mark work done that did not happen.** `server/index.js:874-893` marks a follow-up `sent` and logs billing even when no template is configured. Do the opposite everywhere in this feature.
- **Phones are stored as digits only**, normalised on write. Production holds `054-8139333` unnormalised today.
- **No new scheduler.** Nudges run inside the follow-up processor's pass.
- **Hebrew tests go through Python, never curl in Git Bash** (mojibake on this machine — see `server/scripts/e2e-calendar.md`).
- **Tests:** `cd server && npm test` runs `node --test "test/**/*.test.js"`. It must stay green: 40 tests pass today.
- **DDL is applied by hand.** There is no migration runner. Commit SQL to `wa-studio/docs/sql/` and apply via the Supabase Management API or SQL Editor.

---

## File Structure

**Create:**
- `wa-studio/docs/sql/2026-07-25-relay.sql` — both tables + non-destructive owner backfill
- `server/lib/relay/phone.js` — phone normalisation (pure)
- `server/lib/relay/correlate.js` — match a rep message to an escalation; detect stop (pure)
- `server/lib/relay/contacts.js` — read/resolve `business_contacts` (db seam)
- `server/lib/relay/store.js` — `escalations` CRUD (db seam)
- `server/lib/relay/index.js` — orchestration: raise, handle a contact message, nudge pass
- `server/test/relay-phone.test.js`, `relay-correlate.test.js`, `relay-contacts.test.js`, `relay-store.test.js`, `relay-flow.test.js`

**Modify:**
- `server/agents/conversation.js` — the escalate branch returns a holding line when a relay is available
- `server/index.js` — webhook interception, nudge pass inside the follow-up processor, studio ops
- `server/lib/studio.js` — `getContacts` / `updateContact` ops
- `server/lib/portal.js` — expose contacts read-only to clients
- `wa-studio/src/components/BotPolicyEditor.jsx` — "אנשי קשר" block

---

## Task 1: Phone normalisation

**Files:**
- Create: `server/lib/relay/phone.js`
- Test: `server/test/relay-phone.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `normalizePhone(raw: string): string | null` — digits-only E.164 without `+`, or null if it cannot be normalised.

- [ ] **Step 1: Write the failing test**

```js
// server/test/relay-phone.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone } from '../lib/relay/phone.js';

test('strips punctuation and expands a leading Israeli 0', () => {
  assert.equal(normalizePhone('054-8139333'), '972548139333');
});

test('leaves an already-normalised number alone', () => {
  assert.equal(normalizePhone('972559489893'), '972559489893');
});

test('accepts + and spaces', () => {
  assert.equal(normalizePhone('+972 55 948 9893'), '972559489893');
});

test('rejects anything too short or too long to be a phone', () => {
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('9725594898931234567'), null);
});

test('rejects empty and non-string input', () => {
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone(null), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/relay-phone.test.js`
Expected: FAIL — `Cannot find module '../lib/relay/phone.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// server/lib/relay/phone.js
// Phones are stored digits-only (E.164 without '+'). Production still holds
// unnormalised values like '054-8139333' in the legacy contact columns; every
// write through this feature goes through here.
const IL_COUNTRY = '972';

export function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  let digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('0')) digits = IL_COUNTRY + digits.slice(1);
  return /^\d{10,15}$/.test(digits) ? digits : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/relay-phone.test.js`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add server/lib/relay/phone.js server/test/relay-phone.test.js
git commit -m "feat(relay): phone normalisation for contact numbers"
```

---

## Task 2: Correlation and stop detection

**Files:**
- Create: `server/lib/relay/correlate.js`
- Test: `server/test/relay-correlate.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `STOP_TOKENS: Set<string>`
  - `parseRepMessage(text: string): { code: number | null, body: string }` — strips a leading `#N`
  - `isStopMessage(body: string): boolean` — whole-message match only
  - `resolveEscalation({ contextId, text, openRows }): { row, matchedBy, body, isStop }` where `matchedBy` is `'quote' | 'code' | 'single' | 'recent' | null` and `openRows` is newest-first.

- [ ] **Step 1: Write the failing test**

```js
// server/test/relay-correlate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRepMessage, isStopMessage, resolveEscalation } from '../lib/relay/correlate.js';

const ROWS = [
  { id: 'e2', short_code: 7, rep_message_id: 'wamid.BBB', session_id: '97250000002' },
  { id: 'e1', short_code: 3, rep_message_id: 'wamid.AAA', session_id: '97250000001' },
]; // newest first

test('parseRepMessage strips a leading short code', () => {
  assert.deepEqual(parseRepMessage('#3 כן, עד 3 תשלומים'), { code: 3, body: 'כן, עד 3 תשלומים' });
});

test('parseRepMessage leaves a plain message untouched', () => {
  assert.deepEqual(parseRepMessage('כן, אפשר'), { code: null, body: 'כן, אפשר' });
});

test('isStopMessage matches a whole-message stop word only', () => {
  assert.equal(isStopMessage('עצור'), true);
  assert.equal(isStopMessage('  STOP.  '), true);
  assert.equal(isStopMessage('די יקר, אבל אפשר לפרוס'), false);
});

test('a quoted message wins over everything else', () => {
  const r = resolveEscalation({ contextId: 'wamid.AAA', text: '#7 משהו', openRows: ROWS });
  assert.equal(r.row.id, 'e1');
  assert.equal(r.matchedBy, 'quote');
});

test('a short code resolves when there is no quote', () => {
  const r = resolveEscalation({ contextId: null, text: '#3 כן', openRows: ROWS });
  assert.equal(r.row.id, 'e1');
  assert.equal(r.matchedBy, 'code');
  assert.equal(r.body, 'כן');
});

test('a single open escalation needs no code', () => {
  const r = resolveEscalation({ contextId: null, text: 'כן', openRows: [ROWS[1]] });
  assert.equal(r.row.id, 'e1');
  assert.equal(r.matchedBy, 'single');
});

test('with several open and no hint, the newest wins and is flagged as a guess', () => {
  const r = resolveEscalation({ contextId: null, text: 'כן', openRows: ROWS });
  assert.equal(r.row.id, 'e2');
  assert.equal(r.matchedBy, 'recent');
});

test('nothing open resolves to null', () => {
  const r = resolveEscalation({ contextId: null, text: 'כן', openRows: [] });
  assert.equal(r.row, null);
  assert.equal(r.matchedBy, null);
});

test('a stop message is flagged and still resolves to a row', () => {
  const r = resolveEscalation({ contextId: null, text: '#3 עצור', openRows: ROWS });
  assert.equal(r.row.id, 'e1');
  assert.equal(r.isStop, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/relay-correlate.test.js`
Expected: FAIL — `Cannot find module '../lib/relay/correlate.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// server/lib/relay/correlate.js
// Matching a rep's WhatsApp message to the escalation it answers. The rep has
// ONE thread with the bot, so several leads can be waiting at once.
export const STOP_TOKENS = new Set(['עצור', 'די', 'הפסק', 'הפסיק', 'stop']);

export function parseRepMessage(text) {
  const raw = String(text ?? '').trim();
  const m = raw.match(/^#(\d{1,3})\b[\s.,:;-]*/);
  if (!m) return { code: null, body: raw };
  return { code: Number(m[1]), body: raw.slice(m[0].length).trim() };
}

// Whole-message match only. "די יקר, אבל אפשר לפרוס" is an ANSWER, not a stop.
export function isStopMessage(body) {
  const cleaned = String(body ?? '').trim().replace(/[.!,;:]+$/, '').toLowerCase();
  return STOP_TOKENS.has(cleaned);
}

// openRows must be newest-first.
export function resolveEscalation({ contextId, text, openRows = [] }) {
  const { code, body } = parseRepMessage(text);
  const isStop = isStopMessage(body);
  const out = (row, matchedBy) => ({ row: row ?? null, matchedBy: row ? matchedBy : null, body, isStop });

  if (contextId) {
    const hit = openRows.find(r => r.rep_message_id === contextId);
    if (hit) return out(hit, 'quote');
  }
  if (code != null) {
    const hit = openRows.find(r => r.short_code === code);
    if (hit) return out(hit, 'code');
  }
  if (openRows.length === 1) return out(openRows[0], 'single');
  if (openRows.length > 1) return out(openRows[0], 'recent');
  return out(null, null);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/relay-correlate.test.js`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add server/lib/relay/correlate.js server/test/relay-correlate.test.js
git commit -m "feat(relay): correlate a rep reply to an open escalation"
```

---

## Task 3: DDL and the contacts store

**Files:**
- Create: `wa-studio/docs/sql/2026-07-25-relay.sql`
- Create: `server/lib/relay/contacts.js`
- Test: `server/test/relay-contacts.test.js`

**Interfaces:**
- Consumes: `normalizePhone` (Task 1)
- Produces:
  - `_setDbForTest(fake)`
  - `getContacts(businessId): Promise<Array<{role, name, phone, email, notes}>>`
  - `resolveRep(businessId): Promise<{role, phone, name} | null>` — rep row, else owner row, else null
  - `findContactByPhone(businessId, phone): Promise<contact | null>` — any role
  - `upsertContact(businessId, role, fields): Promise<void>` — normalises phone, rejects an unnormalisable one

- [ ] **Step 1: Write the SQL (applied by hand, not executed by tests)**

```sql
-- wa-studio/docs/sql/2026-07-25-relay.sql
-- Human-rep relay: people + open escalations. Apply once.
begin;

create table if not exists business_contacts (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id),
  role         text not null check (role in ('owner','rep')),
  name         text,
  phone        text,
  email        text,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (business_id, role)
);
create index if not exists business_contacts_phone_idx on business_contacts (phone);

create table if not exists escalations (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id),
  session_id      text not null,
  short_code      int  not null,
  question        text not null,
  reason          text,
  summary         text,
  rep_phone       text not null,
  rep_message_id  text,
  status          text not null default 'open',
  answer          text,
  nudge_count     int  not null default 0,
  last_nudge_at   timestamptz,
  created_at      timestamptz not null default now(),
  answered_at     timestamptz
);
create index if not exists escalations_open_idx on escalations (business_id, status, created_at desc);
create index if not exists escalations_rep_msg_idx on escalations (rep_message_id);

alter table business_contacts enable row level security;
alter table escalations       enable row level security;
revoke all on business_contacts from anon, authenticated;
revoke all on escalations       from anon, authenticated;

-- Non-destructive owner backfill. Legacy columns are left untouched.
insert into business_contacts (business_id, role, name, email, phone)
select b.id, 'owner',
       coalesce(b.contact_name, b.owner_name, p.contact_name),
       coalesce(b.contact_email, p.contact_email),
       regexp_replace(coalesce(b.phone, p.contact_phone, ''), '\D', '', 'g')
from businesses b
left join business_profiles p on p.business_id = b.id::text
on conflict (business_id, role) do nothing;

-- Expand Israeli leading 0 on backfilled rows.
update business_contacts
set phone = '972' || substring(phone from 2)
where phone like '0%';

update business_contacts set phone = null
where phone is not null and phone !~ '^\d{10,15}$';

commit;
```

- [ ] **Step 2: Write the failing test**

```js
// server/test/relay-contacts.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import * as contacts from '../lib/relay/contacts.js';

function fakeDb(rows) {
  const state = { rows: [...rows], upserts: [] };
  return {
    state,
    async listContacts(businessId) { return state.rows.filter(r => r.business_id === businessId); },
    async upsertContact(row) { state.upserts.push(row); },
  };
}

const OWNER = { business_id: 'b1', role: 'owner', name: 'דיוה', phone: '972548139333' };
const REP   = { business_id: 'b1', role: 'rep',   name: 'סאלי', phone: '972500000001' };

test('resolveRep prefers the rep row', async () => {
  contacts._setDbForTest(fakeDb([OWNER, REP]));
  const r = await contacts.resolveRep('b1');
  assert.equal(r.role, 'rep');
  assert.equal(r.phone, '972500000001');
});

test('resolveRep falls back to the owner when there is no rep', async () => {
  contacts._setDbForTest(fakeDb([OWNER]));
  const r = await contacts.resolveRep('b1');
  assert.equal(r.role, 'owner');
});

test('resolveRep returns null when no contact has a phone', async () => {
  contacts._setDbForTest(fakeDb([{ ...OWNER, phone: null }]));
  assert.equal(await contacts.resolveRep('b1'), null);
});

test('findContactByPhone matches either role', async () => {
  contacts._setDbForTest(fakeDb([OWNER, REP]));
  assert.equal((await contacts.findContactByPhone('b1', '972548139333')).role, 'owner');
  assert.equal((await contacts.findContactByPhone('b1', '972500000001')).role, 'rep');
});

test('findContactByPhone normalises the incoming number before matching', async () => {
  contacts._setDbForTest(fakeDb([OWNER]));
  assert.equal((await contacts.findContactByPhone('b1', '054-813-9333')).role, 'owner');
});

test('findContactByPhone does not leak across businesses', async () => {
  contacts._setDbForTest(fakeDb([OWNER]));
  assert.equal(await contacts.findContactByPhone('b2', '972548139333'), null);
});

test('upsertContact normalises the phone on write', async () => {
  const db = fakeDb([]);
  contacts._setDbForTest(db);
  await contacts.upsertContact('b1', 'rep', { name: 'סאלי', phone: '054-8139333' });
  assert.equal(db.state.upserts[0].phone, '972548139333');
});

test('upsertContact rejects an unusable phone instead of storing junk', async () => {
  contacts._setDbForTest(fakeDb([]));
  await assert.rejects(() => contacts.upsertContact('b1', 'rep', { phone: '123' }), /phone/i);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && node --test test/relay-contacts.test.js`
Expected: FAIL — `Cannot find module '../lib/relay/contacts.js'`

- [ ] **Step 4: Write minimal implementation**

```js
// server/lib/relay/contacts.js
// The two humans behind a business: the owner (the client) and the rep who
// answers escalations. One row per role — see the design spec §1.2 for why
// this is a table rather than more columns.
import { normalizePhone } from './phone.js';

let db = null; // test seam
export function _setDbForTest(fake) { db = fake; }

async function realDb() {
  const { supabase } = await import('../supabase.js');
  return {
    async listContacts(businessId) {
      const { data, error } = await supabase.from('business_contacts')
        .select('*').eq('business_id', businessId);
      if (error) throw error;
      return data ?? [];
    },
    async upsertContact(row) {
      const { error } = await supabase.from('business_contacts')
        .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'business_id,role' });
      if (error) throw error;
    },
  };
}

const getDb = async () => db ?? await realDb();

export async function getContacts(businessId) {
  return (await getDb()).listContacts(businessId);
}

export async function resolveRep(businessId) {
  const rows = await getContacts(businessId);
  const withPhone = r => r && r.phone;
  return rows.find(r => r.role === 'rep' && withPhone(r))
      ?? rows.find(r => r.role === 'owner' && withPhone(r))
      ?? null;
}

export async function findContactByPhone(businessId, phone) {
  const norm = normalizePhone(phone);
  if (!norm) return null;
  const rows = await getContacts(businessId);
  return rows.find(r => r.phone === norm) ?? null;
}

export async function upsertContact(businessId, role, fields) {
  const row = { business_id: businessId, role, ...fields };
  if (fields.phone != null && fields.phone !== '') {
    const norm = normalizePhone(fields.phone);
    if (!norm) throw new Error(`unusable phone: ${fields.phone}`);
    row.phone = norm;
  }
  await (await getDb()).upsertContact(row);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && node --test test/relay-contacts.test.js`
Expected: PASS, 8 tests

- [ ] **Step 6: Apply the DDL and confirm**

Apply `wa-studio/docs/sql/2026-07-25-relay.sql` via the Supabase SQL Editor, then verify with a read-only query that every business has an `owner` row and that no `phone` value fails `^\d{10,15}$`.

- [ ] **Step 7: Commit**

```bash
git add wa-studio/docs/sql/2026-07-25-relay.sql server/lib/relay/contacts.js server/test/relay-contacts.test.js
git commit -m "feat(relay): business_contacts + escalations DDL and the contacts store"
```

---

## Task 4: The escalations store

**Files:**
- Create: `server/lib/relay/store.js`
- Test: `server/test/relay-store.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `_setDbForTest(fake)`, `createEscalation(fields)`, `listOpen(businessId)` (newest-first), `nextShortCode(businessId)`, `markAnswered(id, answer)`, `markStopped(id)`, `markExpired(id)`, `recordNudge(id)`, `dueForNudge(intervalHours)`

- [ ] **Step 1: Write the failing test**

```js
// server/test/relay-store.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../lib/relay/store.js';

function fakeDb(rows = []) {
  const state = { rows: [...rows], updates: [] };
  return {
    state,
    async insert(row) { state.rows.push({ id: `e${state.rows.length + 1}`, ...row }); return state.rows.at(-1); },
    async listOpen(businessId) {
      return state.rows.filter(r => r.business_id === businessId && r.status === 'open')
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    },
    async listAllOpen() { return state.rows.filter(r => r.status === 'open'); },
    async update(id, patch) { state.updates.push({ id, patch }); Object.assign(state.rows.find(r => r.id === id) ?? {}, patch); },
  };
}

test('nextShortCode starts at 1 and avoids codes already open', async () => {
  store._setDbForTest(fakeDb([
    { id: 'e1', business_id: 'b1', status: 'open', short_code: 1, created_at: '2026-07-25T10:00:00Z' },
  ]));
  assert.equal(await store.nextShortCode('b1'), 2);
});

test('nextShortCode recycles past 99 rather than growing forever', async () => {
  const rows = Array.from({ length: 99 }, (_, i) => ({
    id: `e${i}`, business_id: 'b1', status: 'open', short_code: i + 1, created_at: '2026-07-25T10:00:00Z',
  }));
  store._setDbForTest(fakeDb(rows));
  const code = await store.nextShortCode('b1');
  assert.ok(code >= 1 && code <= 99);
});

test('listOpen returns newest first', async () => {
  store._setDbForTest(fakeDb([
    { id: 'old', business_id: 'b1', status: 'open', short_code: 1, created_at: '2026-07-25T10:00:00Z' },
    { id: 'new', business_id: 'b1', status: 'open', short_code: 2, created_at: '2026-07-25T12:00:00Z' },
  ]));
  const rows = await store.listOpen('b1');
  assert.equal(rows[0].id, 'new');
});

test('markAnswered records the raw human text and stamps answered_at', async () => {
  const db = fakeDb([{ id: 'e1', business_id: 'b1', status: 'open' }]);
  store._setDbForTest(db);
  await store.markAnswered('e1', 'כן, עד 3 תשלומים');
  const { patch } = db.state.updates[0];
  assert.equal(patch.status, 'answered');
  assert.equal(patch.answer, 'כן, עד 3 תשלומים');
  assert.ok(patch.answered_at);
});

test('recordNudge increments the counter and stamps the time', async () => {
  const db = fakeDb([{ id: 'e1', business_id: 'b1', status: 'open', nudge_count: 1 }]);
  store._setDbForTest(db);
  await store.recordNudge('e1');
  assert.equal(db.state.updates[0].patch.nudge_count, 2);
  assert.ok(db.state.updates[0].patch.last_nudge_at);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/relay-store.test.js`
Expected: FAIL — `Cannot find module '../lib/relay/store.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// server/lib/relay/store.js
// Open questions waiting on a human. Short codes are for humans to type, so
// they recycle within a business rather than being globally unique; collisions
// are impossible because only 'open' rows are ever matched.
let db = null; // test seam
export function _setDbForTest(fake) { db = fake; }

async function realDb() {
  const { supabase } = await import('../supabase.js');
  return {
    async insert(row) {
      const { data, error } = await supabase.from('escalations').insert(row).select().maybeSingle();
      if (error) throw error;
      return data;
    },
    async listOpen(businessId) {
      const { data, error } = await supabase.from('escalations')
        .select('*').eq('business_id', businessId).eq('status', 'open')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
    async update(id, patch) {
      const { error } = await supabase.from('escalations').update(patch).eq('id', id);
      if (error) throw error;
    },
    async listAllOpen() {
      const { data, error } = await supabase.from('escalations')
        .select('*').eq('status', 'open').order('created_at', { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  };
}

const getDb = async () => db ?? await realDb();

const MAX_CODE = 99;

export async function nextShortCode(businessId) {
  const open = await (await getDb()).listOpen(businessId);
  const used = new Set(open.map(r => r.short_code));
  for (let c = 1; c <= MAX_CODE; c++) if (!used.has(c)) return c;
  return 1; // every code in use — reuse the lowest; practically unreachable
}

export async function createEscalation(fields) { return (await getDb()).insert(fields); }
export async function listOpen(businessId)     { return (await getDb()).listOpen(businessId); }
export async function listAllOpen()            { return (await getDb()).listAllOpen(); }

export async function markAnswered(id, answer) {
  await (await getDb()).update(id, { status: 'answered', answer, answered_at: new Date().toISOString() });
}
export async function markStopped(id) { await (await getDb()).update(id, { status: 'stopped' }); }
export async function markExpired(id) { await (await getDb()).update(id, { status: 'expired' }); }

export async function recordNudge(id) {
  const s = await getDb();
  const rows = await s.listAllOpen();
  const current = rows.find(r => r.id === id)?.nudge_count;
  const base = typeof current === 'number' ? current : 0;
  await s.update(id, { nudge_count: base + 1, last_nudge_at: new Date().toISOString() });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/relay-store.test.js`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add server/lib/relay/store.js server/test/relay-store.test.js
git commit -m "feat(relay): escalations store with recycling short codes"
```

---

## Task 5: Raising an escalation

**Files:**
- Create: `server/lib/relay/index.js`
- Modify: `server/agents/conversation.js:31-39`
- Test: `server/test/relay-flow.test.js`

**Interfaces:**
- Consumes: `contacts.resolveRep`, `store.createEscalation`, `store.nextShortCode`
- Produces: `raiseEscalation({ business, session_id, question, reason, summary, persona }): Promise<{ holdingLine: string } | null>` — returns null when no relay is possible, so the caller keeps today's behaviour. Also `_setSenderForTest(fn)`.

- [ ] **Step 1: Write the failing test**

```js
// server/test/relay-flow.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import * as contacts from '../lib/relay/contacts.js';
import * as store from '../lib/relay/store.js';
import * as relay from '../lib/relay/index.js';

const BIZ = { id: 'b1', name: 'קליניקה' };

function seed({ rep = { business_id: 'b1', role: 'rep', name: 'סאלי', phone: '972500000001' } } = {}) {
  contacts._setDbForTest({
    async listContacts() { return rep ? [rep] : []; },
    async upsertContact() {},
  });
  const rows = [];
  store._setDbForTest({
    async insert(row) { const r = { id: `e${rows.length + 1}`, ...row }; rows.push(r); return r; },
    async listOpen() { return [...rows].reverse(); },
    async listAllOpen() { return rows; },
    async update(id, patch) { Object.assign(rows.find(r => r.id === id), patch); },
  });
  return rows;
}

test('raising an escalation messages the rep and returns a holding line', async () => {
  const rows = seed();
  const sent = [];
  relay._setSenderForTest(async (msg) => { sent.push(msg); return { messages: [{ id: 'wamid.X' }] }; });

  const r = await relay.raiseEscalation({
    business: BIZ, session_id: '97250000009',
    question: 'אפשר לפרוס לתשלומים?', reason: 'pricing', summary: 'מתעניינת בטיפול פנים',
    persona: { bot_gender: 'female' },
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, '972500000001');
  assert.match(sent[0].text, /#1/);
  assert.match(sent[0].text, /אפשר לפרוס לתשלומים\?/);
  assert.ok(r.holdingLine.length > 0);
  assert.equal(rows[0].rep_message_id, 'wamid.X');
  assert.equal(rows[0].status, 'open');
});

test('no reachable contact means no escalation row and no holding line', async () => {
  const rows = seed({ rep: null });
  relay._setSenderForTest(async () => { throw new Error('must not send'); });
  const r = await relay.raiseEscalation({
    business: BIZ, session_id: '97250000009', question: 'שאלה', persona: {},
  });
  assert.equal(r, null);
  assert.equal(rows.length, 0);
});

test('a failed send leaves no escalation behind', async () => {
  const rows = seed();
  relay._setSenderForTest(async () => null); // send failed — no message id
  const r = await relay.raiseEscalation({
    business: BIZ, session_id: '97250000009', question: 'שאלה', persona: {},
  });
  assert.equal(r, null, 'must not promise the lead an answer nobody was asked for');
  assert.equal(rows.filter(x => x.status === 'open').length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/relay-flow.test.js`
Expected: FAIL — `Cannot find module '../lib/relay/index.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// server/lib/relay/index.js
// Escalation relay: ask a human, then answer the lead in the bot's voice.
import { resolveRep } from './contacts.js';
import * as store from './store.js';

let sender = null; // test seam
export function _setSenderForTest(fn) { sender = fn; }

async function send(msg) {
  if (sender) return sender(msg);
  const { sendWhatsAppMessage } = await import('../wa-send.js');
  return sendWhatsAppMessage(msg);
}

function holdingLineFor(persona) {
  return persona?.bot_gender === 'male'
    ? 'אני צריך לבדוק את זה, אעדכן בקרוב.'
    : 'אני צריכה לבדוק את זה, אעדכן בקרוב.';
}

function repMessage({ code, leadName, summary, question }) {
  const who = leadName ? ` · ${leadName}` : '';
  const ctx = summary ? `\nסיכום: ${summary}` : '';
  return `#${code}${who}${ctx}\nהשאלה: ${question}\n\nענו להודעה הזו (Reply) כדי שאעביר את התשובה.`;
}

// Returns null when no relay is possible — the caller then keeps today's
// behaviour. NEVER tell a lead we are checking if nobody was asked.
export async function raiseEscalation({ business, session_id, question, reason = null, summary = null, leadName = null, persona = {} }) {
  try {
    const rep = await resolveRep(business.id);
    if (!rep) return null;

    const code = await store.nextShortCode(business.id);
    const res = await send({
      to: rep.phone,
      text: repMessage({ code, leadName, summary, question }),
      businessId: business.id,
    });
    const repMessageId = res?.messages?.[0]?.id ?? null;
    if (!repMessageId) return null;

    await store.createEscalation({
      business_id: business.id, session_id, short_code: code,
      question, reason, summary, rep_phone: rep.phone,
      rep_message_id: repMessageId, status: 'open',
      created_at: new Date().toISOString(),
    });

    return { holdingLine: holdingLineFor(persona) };
  } catch (e) {
    console.error('[relay] raise failed:', e.message);
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/relay-flow.test.js`
Expected: PASS, 3 tests

- [ ] **Step 5: Wire it into the escalate branch**

In `server/agents/conversation.js`, the escalate branch currently returns a hardcoded sentence. Replace the body of `if (intent.escalate) { … }` so it first attempts the relay:

```js
if (intent.escalate) {
  const { raiseEscalation } = await import('../lib/relay/index.js');
  const relayed = business_profile?.business_id
    ? await raiseEscalation({
        business: { id: business_profile.business_id, name: business_profile.business_name ?? '' },
        session_id, question: message,
        reason: intent.escalation_reason ?? null,
        summary: context.contact_summary ?? null,
        persona,
      })
    : null;
  const phrase = relayed?.holdingLine
    ?? persona?.escalation_phrase
    ?? (persona?.bot_gender === 'male' ? 'אני מעביר אותך לנציג שלנו כעת.' : 'אני מעבירה אותך לנציגה שלנו כעת.');
  return ok({
    response: phrase, next_stage: 'escalated', action: 'none',
    cta_triggered: false, escalate: true,
    escalation_reason: intent.escalation_reason,
    qualification_progress: intent.qualification_progress ?? context.qualification_progress ?? {},
    language: intent.language ?? 'hebrew',
  });
}
```

Note the fallback string is now gender-aware — today's hardcoded `'אני מעביר אותך'` is masculine even for a bot configured female, which `identityText()` otherwise enforces.

- [ ] **Step 6: Run the full suite**

Run: `cd server && npm test`
Expected: all tests pass (40 existing + the new ones)

- [ ] **Step 7: Commit**

```bash
git add server/lib/relay/index.js server/agents/conversation.js server/test/relay-flow.test.js
git commit -m "feat(relay): raise an escalation and hold the lead instead of dead-ending"
```

---

## Task 6: Intercept contact messages in the webhook

**Files:**
- Modify: `server/index.js` (the `/wa-inbound` handler, before `runAgentPipeline`)
- Test: `server/test/relay-flow.test.js` (extend)

**Interfaces:**
- Consumes: `contacts.findContactByPhone`
- Produces: `handleContactMessage({ business, from, text, contextId }): Promise<boolean>` in `server/lib/relay/index.js` — true when the message was consumed by the relay.

- [ ] **Step 1: Write the failing test**

```js
test('a contact message is consumed by the relay and never reaches the agent', async () => {
  const rows = seed();
  relay._setSenderForTest(async () => ({ messages: [{ id: 'wamid.X' }] }));
  await relay.raiseEscalation({ business: BIZ, session_id: '97250000009', question: 'שאלה', persona: {} });

  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.Y' }] }; });

  const consumed = await relay.handleContactMessage({
    business: BIZ, from: '972500000001', text: 'כן, אפשר לפרוס', contextId: 'wamid.X',
  });

  assert.equal(consumed, true);
  assert.equal(rows[0].status, 'answered');
  assert.equal(rows[0].answer, 'כן, אפשר לפרוס');
  assert.ok(sent.some(m => m.to === '97250000009'), 'the lead receives the answer');
});

test('a message from an unknown number is not consumed', async () => {
  seed();
  const consumed = await relay.handleContactMessage({
    business: BIZ, from: '972999999999', text: 'שלום', contextId: null,
  });
  assert.equal(consumed, false);
});

test('a whole-message stop closes the escalation without answering the lead', async () => {
  const rows = seed();
  relay._setSenderForTest(async () => ({ messages: [{ id: 'wamid.X' }] }));
  await relay.raiseEscalation({ business: BIZ, session_id: '97250000009', question: 'שאלה', persona: {} });

  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.Z' }] }; });
  await relay.handleContactMessage({ business: BIZ, from: '972500000001', text: 'עצור', contextId: null });

  assert.equal(rows[0].status, 'stopped');
  assert.ok(!sent.some(m => m.to === '97250000009'), 'the lead must not be messaged on stop');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test test/relay-flow.test.js`
Expected: FAIL — `relay.handleContactMessage is not a function`

- [ ] **Step 3: Implement**

Append to `server/lib/relay/index.js`:

```js
import { findContactByPhone } from './contacts.js';
import { resolveEscalation } from './correlate.js';

// Rewrites the human's answer into the bot's voice WITHOUT passing it through
// validate() or the forbidden-phrase check: the rep IS the business, so their
// answer is authoritative. Content must survive verbatim — only tone changes.
async function voiceRewrite(answer /*, persona */) {
  return answer; // Task 7 replaces this with a model call
}

export async function handleContactMessage({ business, from, text, contextId, persona = null }) {
  try {
    const contact = await findContactByPhone(business.id, from);
    if (!contact) return false;

    const open = await store.listOpen(business.id);
    const { row, matchedBy, body, isStop } = resolveEscalation({ contextId, text, openRows: open });

    if (!row) {
      await send({ to: from, text: 'אין כרגע שאלה שממתינה לתשובה.', businessId: business.id });
      return true;
    }

    if (isStop) {
      await store.markStopped(row.id);
      await send({ to: from, text: `הופסק ✓ (${row.session_id})`, businessId: business.id });
      return true;
    }

    const reply = await voiceRewrite(body, persona);
    await send({ to: row.session_id, text: reply, businessId: business.id });
    await store.markAnswered(row.id, body);

    // When we had to guess, name the thread so a mis-route is visible at once.
    const ack = matchedBy === 'recent' ? `נשלח ✓ (${row.session_id})` : 'נשלח ✓';
    await send({ to: from, text: ack, businessId: business.id });
    return true;
  } catch (e) {
    console.error('[relay] contact message failed:', e.message);
    return false;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && node --test test/relay-flow.test.js`
Expected: PASS

- [ ] **Step 5: Wire into the webhook**

In `server/index.js`, inside the `/wa-inbound` POST handler after the payload is classified as a `message` and the business is resolved from `value.metadata.phone_number_id`, insert **before** `runAgentPipeline` is called:

```js
const { handleContactMessage } = await import('./lib/relay/index.js');
const { data: relayProfile } = await supabase.from('business_profiles')
  .select('persona').eq('business_id', biz.id).maybeSingle();
const consumed = await handleContactMessage({
  business: { id: biz.id, name: biz.name ?? '' },
  from: value.messages[0].from,
  text: value.messages[0].text?.body ?? '',
  contextId: value.messages[0].context?.id ?? null,
  persona: relayProfile?.persona ?? null,
});
if (consumed) return; // never reaches the conversation agent, no contacts row
```

- [ ] **Step 6: Run the full suite and commit**

```bash
cd server && npm test
git add server/lib/relay/index.js server/index.js server/test/relay-flow.test.js
git commit -m "feat(relay): intercept contact messages before the conversation agent"
```

---

## Task 7: Voice rewrite that preserves content

**Files:**
- Modify: `server/lib/relay/index.js`
- Test: `server/test/relay-flow.test.js` (extend)

**Interfaces:**
- Produces: `_setRewriterForTest(fn)`; `voiceRewrite(answer, persona)` uses it when set.

- [ ] **Step 1: Write the failing test**

```js
test('the rewriter is given the raw human answer and its output is what the lead gets', async () => {
  const rows = seed();
  relay._setSenderForTest(async () => ({ messages: [{ id: 'wamid.X' }] }));
  await relay.raiseEscalation({ business: BIZ, session_id: '97250000009', question: 'שאלה', persona: {} });

  const seenByRewriter = [];
  relay._setRewriterForTest(async (answer) => { seenByRewriter.push(answer); return `בשמחה! ${answer}` });
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.Y' }] }; });

  await relay.handleContactMessage({ business: BIZ, from: '972500000001', text: '400 ₪ לחודש', contextId: 'wamid.X' });

  assert.deepEqual(seenByRewriter, ['400 ₪ לחודש']);
  const toLead = sent.find(m => m.to === '97250000009');
  assert.match(toLead.text, /400 ₪ לחודש/, 'the human figure must survive verbatim');
  assert.equal(rows[0].answer, '400 ₪ לחודש', 'the audit trail stores the raw human text');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test test/relay-flow.test.js`
Expected: FAIL — `relay._setRewriterForTest is not a function`

- [ ] **Step 3: Implement**

Replace the placeholder `voiceRewrite` in `server/lib/relay/index.js`:

```js
let rewriter = null; // test seam
export function _setRewriterForTest(fn) { rewriter = fn; }

const REWRITE_PROMPT = `אתה מנסח מחדש תשובה של בעל העסק כך שתישמע בקול של הבוט.
חוקים מוחלטים:
- אל תשנה, תוסיף או תוריד שום עובדה, מספר, מחיר, תאריך או שם.
- אל תרכך ואל תסייג. התשובה של בעל העסק היא הקובעת.
- שמור על אורך דומה, בעברית, בגוף ראשון.
החזר את הטקסט בלבד.`;

async function voiceRewrite(answer, persona) {
  if (rewriter) return rewriter(answer, persona);
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const gender = persona?.bot_gender === 'male' ? 'זכר' : 'נקבה';
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: `${REWRITE_PROMPT}\nמגדר הבוט: ${gender}\n\nהתשובה:\n${answer}` }],
    });
    return res.content?.[0]?.text?.trim() || answer;
  } catch (e) {
    console.error('[relay] rewrite failed, sending the raw answer:', e.message);
    return answer; // the human's words are always better than nothing
  }
}
```

`handleContactMessage` already accepts `persona` (Task 6) and passes it straight to `voiceRewrite`. Load it in the webhook call site from `business_profiles.persona` for the business that owns the receiving number, so the rewrite honours the bot's configured gender. **Do not** route this text through `validate()` (`conversation.js:275`) or the `guardrails.forbidden_phrases` check (`:279`) — the rep is the business and their answer is authoritative.

- [ ] **Step 4: Run to verify it passes, then the full suite**

Run: `cd server && npm test`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add server/lib/relay/index.js server/test/relay-flow.test.js
git commit -m "feat(relay): rewrite the human answer into the bot voice, content verbatim"
```

---

## Task 8: Nudges

**Files:**
- Modify: `server/lib/relay/index.js`, `server/index.js` (follow-up processor)
- Test: `server/test/relay-nudge.test.js`

**Interfaces:**
- Produces: `nudgePass({ now, isOpenNow, intervalHours, maxNudges }): Promise<{ nudged: number, expired: number }>` where `isOpenNow(businessId): Promise<boolean>` injects the working-hours check.

- [ ] **Step 1: Write the failing test**

```js
// server/test/relay-nudge.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../lib/relay/store.js';
import * as relay from '../lib/relay/index.js';

const HOUR = 3600 * 1000;

function seedOpen(rows) {
  const state = [...rows];
  store._setDbForTest({
    async insert(r) { state.push(r); return r; },
    async listOpen(b) { return state.filter(r => r.business_id === b && r.status === 'open'); },
    async listAllOpen() { return state.filter(r => r.status === 'open'); },
    async update(id, patch) { Object.assign(state.find(r => r.id === id), patch); },
  });
  return state;
}

test('an escalation past the interval is nudged inside working hours', async () => {
  const now = new Date('2026-07-26T09:00:00Z');
  const rows = seedOpen([{ id: 'e1', business_id: 'b1', status: 'open', short_code: 1,
    rep_phone: '972500000001', session_id: '9725000009', nudge_count: 0,
    last_nudge_at: new Date(now - 3 * HOUR).toISOString() }]);
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'x' }] }; });

  const r = await relay.nudgePass({ now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4 });

  assert.equal(r.nudged, 1);
  assert.equal(sent[0].to, '972500000001');
  assert.equal(rows[0].nudge_count, 1);
});

test('outside working hours nothing is sent and the counter is untouched', async () => {
  const now = new Date('2026-07-26T02:00:00Z');
  const rows = seedOpen([{ id: 'e1', business_id: 'b1', status: 'open', short_code: 1,
    rep_phone: '972500000001', session_id: '9725000009', nudge_count: 1,
    last_nudge_at: new Date(now - 5 * HOUR).toISOString() }]);
  relay._setSenderForTest(async () => { throw new Error('must not send at night'); });

  const r = await relay.nudgePass({ now, isOpenNow: async () => false, intervalHours: 2, maxNudges: 4 });

  assert.equal(r.nudged, 0);
  assert.equal(rows[0].nudge_count, 1, 'a quiet night must not consume the nudge budget');
});

test('an escalation inside the interval is left alone', async () => {
  const now = new Date('2026-07-26T09:00:00Z');
  seedOpen([{ id: 'e1', business_id: 'b1', status: 'open', short_code: 1,
    rep_phone: '972500000001', session_id: '9725000009', nudge_count: 0,
    last_nudge_at: new Date(now - 30 * 60 * 1000).toISOString() }]);
  relay._setSenderForTest(async () => { throw new Error('too soon'); });

  const r = await relay.nudgePass({ now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4 });
  assert.equal(r.nudged, 0);
});

test('at the ceiling the escalation expires and the lead is not messaged', async () => {
  const now = new Date('2026-07-26T09:00:00Z');
  const rows = seedOpen([{ id: 'e1', business_id: 'b1', status: 'open', short_code: 1,
    rep_phone: '972500000001', session_id: '9725000009', nudge_count: 4,
    last_nudge_at: new Date(now - 5 * HOUR).toISOString() }]);
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'x' }] }; });

  const r = await relay.nudgePass({ now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4 });

  assert.equal(r.expired, 1);
  assert.equal(rows[0].status, 'expired');
  assert.ok(!sent.some(m => m.to === '9725000009'), 'the lead is never messaged by the nudge pass');
});

test('an escalation never nudged yet uses created_at as the clock', async () => {
  const now = new Date('2026-07-26T09:00:00Z');
  seedOpen([{ id: 'e1', business_id: 'b1', status: 'open', short_code: 1,
    rep_phone: '972500000001', session_id: '9725000009', nudge_count: 0,
    last_nudge_at: null, created_at: new Date(now - 4 * HOUR).toISOString() }]);
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'x' }] }; });

  const r = await relay.nudgePass({ now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4 });
  assert.equal(r.nudged, 1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test test/relay-nudge.test.js`
Expected: FAIL — `relay.nudgePass is not a function`

- [ ] **Step 3: Implement**

Append to `server/lib/relay/index.js`:

```js
// Nudges ride the follow-up processor's pass — this feature does not add a
// second scheduler. Every nudge outside the 24h window is a billable
// business-initiated conversation, hence the ceiling.
export async function nudgePass({ now = new Date(), isOpenNow, intervalHours = 2, maxNudges = 4 }) {
  let nudged = 0, expired = 0;
  const open = await store.listAllOpen();
  for (const row of open) {
    try {
      const since = new Date(row.last_nudge_at ?? row.created_at ?? now).getTime();
      if (now.getTime() - since < intervalHours * 3600 * 1000) continue;
      if (row.nudge_count >= maxNudges) { await store.markExpired(row.id); expired++; continue; }
      if (!(await isOpenNow(row.business_id))) continue; // no counter change
      await send({
        to: row.rep_phone,
        text: `תזכורת #${row.short_code} — עדיין ממתינה תשובה:\n${row.question}\n\nלהפסקת התזכורות השיבו "עצור".`,
        businessId: row.business_id,
      });
      await store.recordNudge(row.id);
      nudged++;
    } catch (e) {
      console.error('[relay] nudge failed for', row.id, e.message);
    }
  }
  return { nudged, expired };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && node --test test/relay-nudge.test.js`
Expected: PASS, 5 tests

- [ ] **Step 5: Call it from the follow-up processor**

In `server/index.js`, inside the `POST /follow-up/process` handler, after the existing follow-up loop, add:

```js
const { nudgePass } = await import('./lib/relay/index.js');
const nudges = await nudgePass({
  isOpenNow: async (businessId) => {
    const { data } = await supabase.from('business_profiles')
      .select('working_hours').eq('business_id', businessId).maybeSingle();
    return isWithinWorkingHours(data?.working_hours);
  },
});
```

Include `nudges` in the handler's JSON response so a cron run is observable.

- [ ] **Step 6: Run the full suite and commit**

```bash
cd server && npm test
git add server/lib/relay/index.js server/index.js server/test/relay-nudge.test.js
git commit -m "feat(relay): 2-hourly nudges bounded by working hours and a ceiling"
```

---

## Task 9: Admin surface

**Files:**
- Modify: `server/lib/studio.js`, `wa-studio/src/components/BotPolicyEditor.jsx`

**Interfaces:**
- Consumes: `contacts.getContacts`, `contacts.upsertContact`
- Produces: studio ops `getBusinessContacts(business_id)` and `setBusinessContact(business_id, role, fields)`

- [ ] **Step 1: Add the studio ops**

In `server/lib/studio.js`, next to the existing module ops:

```js
export async function getBusinessContacts(business_id) {
  const { getContacts } = await import('./relay/contacts.js');
  const rows = await getContacts(business_id);
  const byRole = Object.fromEntries(rows.map(r => [r.role, r]));
  return { owner: byRole.owner ?? null, rep: byRole.rep ?? null };
}

export async function setBusinessContact(business_id, role, fields) {
  if (!['owner', 'rep'].includes(role)) throw new Error('invalid role');
  const { upsertContact } = await import('./relay/contacts.js');
  await upsertContact(business_id, role, {
    name: fields.name ?? null, phone: fields.phone ?? null,
    email: fields.email ?? null, notes: fields.notes ?? null,
  });
  return { ok: true };
}
```

Register both in the op map the `/studio/rpc` dispatcher uses, alongside `getModules` / `updateModule`.

- [ ] **Step 2: Add the UI block**

In `wa-studio/src/components/BotPolicyEditor.jsx`, add an "אנשי קשר" section following the file's existing section pattern:

```jsx
function ContactFields({ label, hint, value, onChange }) {
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value })
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>{label}</div>
      <input placeholder="שם"    value={value?.name  ?? ''} onChange={set('name')}  dir="rtl" />
      <input placeholder="טלפון" value={value?.phone ?? ''} onChange={set('phone')} dir="ltr" />
      <input placeholder="אימייל" value={value?.email ?? ''} onChange={set('email')} dir="ltr" />
      <textarea placeholder="הערות" value={value?.notes ?? ''} onChange={set('notes')} rows={2} dir="rtl" />
      {hint && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{hint}</div>}
    </div>
  )
}
```

Render two of them — `בעל העסק` (role `owner`) and `נציג אנושי` (role `rep`, hint `אם ריק, האסקלציות יגיעו לבעל העסק`) — loaded once via the `getBusinessContacts` op and saved per role via `setBusinessContact`. Below them add number inputs for nudge interval (default 2) and ceiling (default 4), saved to `business_profiles`, and a single warning line: `מספר שמופיע כאן לא יוכל לכתוב לבוט כליד`.

Do **not** reuse `BusinessPreferences.handleSave` for this — it posts ten fields at once through the unallowlisted `/business/update`, so saving contacts there would rewrite the business's persona and guardrails in the same request.

- [ ] **Step 3: Expose the contacts read-only to the client**

In `server/lib/portal.js`, add `getBusinessContacts` to the op whitelist so the client dashboard can *display* both contacts, with `business_id` taken from the signed token as every other portal op does. Do **not** whitelist `setBusinessContact`: a client silently redirecting their own escalations to a wrong number is a support incident, so changing them stays an operator action.

Render them read-only in the client settings tab (`wa-studio/src/components/FaqSettings.jsx`, next to the existing schedule block) as plain labelled text, with no inputs.

- [ ] **Step 4: Verify the build**

Run: `cd wa-studio && npx vite build`
Expected: build succeeds

- [ ] **Step 5: Commit**

```bash
git add server/lib/studio.js server/lib/portal.js wa-studio/src/components/BotPolicyEditor.jsx wa-studio/src/components/FaqSettings.jsx
git commit -m "feat(studio): owner and rep contact management, read-only for clients"
```

---

## Task 10: Templates, env, and the end-to-end runbook

**Files:**
- Create: `server/scripts/e2e-relay.md`
- Modify: `server/lib/relay/index.js` (template sends), `server/.env.local` + Railway

**Interfaces:**
- Consumes: `sendWhatsAppTemplate` from `server/lib/wa-send.js`
- Produces: env `WHATSAPP_ESCALATION_TEMPLATE`, `WHATSAPP_NUDGE_TEMPLATE`

- [ ] **Step 1: Submit the templates in WhatsApp Manager**

Two Hebrew templates, submitted together with the pending follow-up template to avoid a second approval round trip:
- `escalation_notify` — body params: `{{1}}` short code, `{{2}}` lead name, `{{3}}` summary, `{{4}}` question
- `escalation_nudge` — body params: `{{1}}` short code, `{{2}}` question

- [ ] **Step 2: Send via template when outside the 24h window**

Add a contact-specific sender to `server/lib/relay/index.js` and use it for both the escalation and the nudge. Leads keep the plain text send — they have just messaged, so they are inside the window.

```js
// Business-initiated sends to a contact usually fall outside WhatsApp's 24h
// window, so they must go out as an approved template. A missing template is a
// hard stop, never a silent success: index.js:874-893 gets this wrong for
// follow-ups by marking them 'sent' with nothing sent.
async function sendToContact({ to, businessId, templateEnv, bodyParams, fallbackText }) {
  if (sender) return sender({ to, businessId, text: fallbackText });
  const templateName = process.env[templateEnv];
  if (!templateName) {
    console.error(`[relay] ${templateEnv} is not configured — refusing to send`);
    return null;
  }
  const { sendWhatsAppTemplate } = await import('../wa-send.js');
  return sendWhatsAppTemplate({ to, templateName, langCode: 'he', bodyParams, businessId });
}
```

In `raiseEscalation`, replace the `send({ to: rep.phone, … })` call with `sendToContact({ to: rep.phone, businessId: business.id, templateEnv: 'WHATSAPP_ESCALATION_TEMPLATE', bodyParams: [code, leadName ?? '', summary ?? '', question], fallbackText: repMessage({ code, leadName, summary, question }) })`. Because the existing test asserts that a send returning no message id creates no escalation row, an unset template already produces the correct behaviour — no row, no holding line, and the lead falls back to today's escalation sentence.

In `nudgePass`, use the same helper with `templateEnv: 'WHATSAPP_NUDGE_TEMPLATE'` and `bodyParams: [row.short_code, row.question]`.

- [ ] **Step 3: Write the runbook**

Create `server/scripts/e2e-relay.md` documenting the fake-sender run on the `is_test` tenant (Leadz, `1037d6c1`) with a throwaway `session_id`: lead escalates → rep receives → rep quote-replies → lead receives the answer → escalation `answered`. Use Python, not curl, for the Hebrew payloads. Warn that `server/index.js:331` sends over WhatsApp on every live turn and that this tenant's existing sessions are real phone numbers.

- [ ] **Step 4: Run the full suite and commit**

```bash
cd server && npm test
git add server/lib/relay/index.js server/scripts/e2e-relay.md
git commit -m "feat(relay): template sends for the rep hop + E2E runbook"
```

---

## Deferred, deliberately

- **Retiring the duplicate contact columns.** The backfill copies into `business_contacts`; the legacy columns keep working. Cleanup is separate work.
- **Any new `contacts.status` value for "waiting on a human".** `upsertContact`'s ladder clobbers values outside `statusOrder` — 9 of 14 production contacts are affected today. Fix that first.
- **Re-engaging a lead after an escalation expires.** That is the follow-up system's job.
- **A second rep, rotation, or on-call schedules.** One row per role until a client asks otherwise.
