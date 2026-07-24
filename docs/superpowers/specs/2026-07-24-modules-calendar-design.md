# Modules Infrastructure + Calendar Booking Module — Design

**Date:** 2026-07-24
**Status:** Approved by user (conversation), pending spec review
**Drives:** per-client feature modules; module #1 = calendar meeting booking (Google now, Outlook later)

## Decisions made with the user

| Question | Decision |
|---|---|
| Booking flow | Both flows, chosen per business: `autonomous` or `owner_confirmed` |
| Providers | Google Calendar now, behind a provider interface; Outlook (MS Graph) later |
| Connect UX | Admin generates a one-time connect link; client approves with their own Google account |
| Module system | Full infrastructure: dedicated table, settings schemas, audit/billing log, portal visibility |
| Agent mechanism | Context injection + structured actions (single LLM call; server executes) |
| Availability model | Weekly bookable-hours template + per-week (per-date) overrides; earliest-free-slot-first; freeBusy check before every offer; roll to next slot / next day when blocked or duration no longer fits |

## 1. Module infrastructure

### 1.1 Data

**`business_modules`** (new table; anon/authenticated REVOKEd, service-role only, like `portal_accounts`):

```sql
create table business_modules (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id),
  module_key   text not null,
  enabled      boolean not null default false,
  settings     jsonb not null default '{}',
  secrets      jsonb not null default '{}',   -- encrypted values only (see 1.4)
  status       text not null default 'disconnected',  -- disconnected|connected|error
  status_detail text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (business_id, module_key)
);
```

**`module_events`** (audit trail — security spec B-01 — and usage counter for future per-module billing):

```sql
create table module_events (
  id           bigint generated always as identity primary key,
  business_id  uuid not null,
  module_key   text not null,
  event_type   text not null,   -- action.book | action.book_failed | connect | disconnect | token_error | context_error
  detail       jsonb,
  created_at   timestamptz not null default now()
);
```

DDL is committed as `wa-studio/docs/sql/2026-07-24-modules.sql`; user applies via Supabase SQL Editor (no automated DDL path).

### 1.2 Registry

`server/lib/modules/registry.js` exports the catalog. A module definition:

```js
{
  key: 'calendar',
  name: 'תיאום פגישות ביומן',
  settingsSchema,        // zod — validates settings on every write (spec D-01)
  defaultSettings,
  contextProvider,       // async (business, module) => string|null  — prompt block pre-LLM-call
  actions: {             // name => { schema (zod), handler: async (business, module, payload, sessionCtx) }
    book: { schema, handler },
  },
  adminUI,               // descriptor: fields for BotPolicyEditor form + connect widget type
  portalVisible: false,  // v1: calendar not shown in client portal
}
```

### 1.3 Agent pipeline integration (structured-action protocol)

In `runAgentPipeline` (server/index.js), for live conversation replies:

1. **Pre-call:** load enabled modules for the business (single query, cached per request). For each, call `contextProvider`; non-null results are appended to the system prompt under a `## יכולות פעילות` section. Provider errors → log `context_error`, skip block (never fake data, never crash the reply).
2. **Instruction:** the calendar context block ends with action instructions, e.g.: to book, append on its own line `<<ACTION:calendar.book{"slot":"2026-07-26T10:00","name":"...","phone":"..."}>>`.
3. **Post-call:** scan the model reply for `<<ACTION:(\w+)\.(\w+)\{...\}>>` (max 1 action per reply, v1). Strip the marker from the visible text. Validate module enabled + action exists + payload parses against the action's zod schema. Execute the handler; the handler returns `{confirmationText}` or `{failureText}` which is appended to the customer-visible reply. Any validation/execution failure → marker stripped, `action_failed` logged, reply still goes out clean.
4. Every execution (success and failure) → `module_events` row.

The model never performs side effects — it *requests*; the server validates, verifies, and executes.

### 1.4 Secrets encryption

`server/lib/modules/crypto.js`: AES-256-GCM, key from new env `MODULE_SECRETS_KEY` (32-byte, base64; on Railway + server/.env.local). Stored shape per secret: `{iv, tag, data}` (base64). `secrets` column never holds plaintext. Spec items C-04/F-04.

### 1.5 Admin UI (BotPolicyEditor)

New "מודולים" section: catalog list → per module: enable toggle, settings form rendered from `adminUI` descriptor, status light (ירוק connected / אדום error / אפור disconnected), and for calendar a "צור קישור חיבור" button + copyable link. Saves go through a new studio op `updateModule(businessId, moduleKey, {enabled, settings})` (server-side zod validation). New op `getModules(businessId)` returns modules with settings + status, **never secrets**.

## 2. Calendar module

### 2.1 Provider interface

`server/lib/modules/calendar/providers/google.js` (later `outlook.js`, same surface):

```js
getAuthUrl(state)                       // consent URL, scopes: calendar.events + calendar.readonly (minimal)
exchangeCode(code)                      // => {refresh_token, access_token, expiry, account_email}
freeBusy(tokens, fromISO, toISO)        // => [{start, end}] busy ranges, primary calendar
createEvent(tokens, {start, end, title, description, tentative}) // => {eventId, htmlLink}
```

Token refresh handled inside the provider; a refresh failure bubbles as `TOKEN_ERROR` → module status `error` + `status_detail`, event logged.

### 2.2 Settings (zod schema)

```js
{
  mode: 'autonomous' | 'owner_confirmed',        // default 'owner_confirmed' (safe default)
  duration_min: number,                          // default 30
  buffer_min: number,                            // default 0
  horizon_days: number,                          // default 14, max 60
  min_notice_hours: number,                      // default 3
  weekly: { sun..sat: [{from:'HH:MM', to:'HH:MM'}] },  // recurring bookable windows (may differ from answering hours)
  overrides: { 'YYYY-MM-DD': [{from,to}] | [] }, // per-date replacement; [] = closed that day (the "per-week" calendar)
  event_title: string,                           // template, default 'פגישה — {name}'
  timezone: 'Asia/Jerusalem',                    // fixed v1
  jewish_holidays_closed: boolean,               // default true, reuses existing holiday set
}
```

### 2.3 Slot engine — `server/lib/modules/calendar/slots.js` (pure, unit-tested)

`computeSlots(settings, busyRanges, nowISO)`:

1. For each day in `[now + min_notice, now + horizon_days]`: windows = `overrides[date]` if present, else `weekly[weekday]`; skip holidays if configured.
2. Within each window, generate candidate starts every `duration + buffer` minutes; a candidate is valid only if `[start, start + duration]` fits entirely inside the window **and** overlaps no busy range.
3. Returns ordered list (earliest first). If nothing fits in a day (blocked or the remaining window is shorter than the duration), the day contributes nothing — the next candidate naturally comes from the following day. This implements the user's rule: blocked → next slot; doesn't fit today → next day.

**Context block:** compact Hebrew, grouped per day (up to ~horizon, capped ~40 slots), with explicit guidance: *offer the earliest slot first*; if the customer asks for a specific day/time, use the list; never invent times not on the list.

### 2.4 Booking flows

**Autonomous:** model emits `calendar.book{slot, name, phone}` → handler validates slot is on the currently-computed list → **re-runs freeBusy for that exact range** (race protection) → free: `createEvent` (description carries name, phone, WhatsApp link, "נקבע ע"י הסוכן") → confirmation text with day/date/time. Busy meanwhile: `failureText` = "הזמן הזה בדיוק נתפס" + the next 2 free alternatives.

**Owner-confirmed:** identical, but the event is created with title prefix "⏳ ממתין לאישור: " and the confirmation to the customer says the meeting will be confirmed shortly; if the business has a connected WA owner number, a notification message is sent via `wa-send`. Owner approves by editing/keeping the calendar event (no in-app approval screen in v1).

Both flows also upsert the lead in `contacts` with status `meeting_booked` (extends the existing pipeline ladder).

### 2.5 OAuth connect flow

1. Admin clicks "צור קישור חיבור" → studio op `createConnectLink(businessId, 'calendar')` → HMAC-signed state `{business_id, module, exp: +48h}` (reuses the portal token signer pattern, `PORTAL_TOKEN_SECRET`) → returns `https://wagent.divdev.co/oauth/google/start?state=...`.
2. `GET /oauth/google/start` — verifies state, redirects to Google consent (`access_type=offline`, `prompt=consent` to force a refresh token).
3. `GET /oauth/google/callback` — verifies state, exchanges code, encrypts + stores tokens in `business_modules.secrets`, sets status `connected`, logs `connect`, renders a tiny Hebrew success page ("היומן חובר, אפשר לסגור").
4. Both routes are **public paths** in `studioAuth` (the client, not the admin, opens them); safety comes from the signed state.

**Prerequisite (user, ~15 min):** Google Cloud OAuth Client (Web application), redirect URI `https://wagent.divdev.co/oauth/google/callback`; envs `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MODULE_SECRETS_KEY` on Railway + local. Client emails added as test users until app verification.

## 3. Error handling

| Failure | Behavior |
|---|---|
| Token revoked / refresh fails | status `error`, contextProvider returns null (agent stops offering slots, falls back to collecting details for manual scheduling), admin sees red + detail |
| Google API down / freeBusy error | same as above for this request; logged `context_error`; never fake availability |
| Action payload invalid / slot not on list | no side effect; marker stripped; `action_failed` logged |
| Slot race (taken between offer and book) | re-check catches it; alternatives offered |
| Marker parse edge cases (model malformed JSON) | strip whatever matched, log, clean reply |

## 4. Testing

- **Unit (pure):** `slots.js` — windows/overrides/holidays, buffer, min-notice, duration-doesn't-fit-rolls-to-next-day, busy-overlap edge touching boundaries, DST transition week; action-marker parser (valid, malformed JSON, unknown action, injection attempt inside customer text); crypto round-trip.
- **E2E (scripted, real test Google account + prod-like server):** connect link flow; availability reflects a real busy event; autonomous book creates a real event with correct duration; race simulation (insert event between offer and book); owner-confirmed creates tentative + notification; token revocation → graceful degradation.
- **Playwright:** modules section renders, toggle + settings save, connect link copyable.

## 5. Rollout order

1. DDL file → user applies in SQL Editor.
2. Server: crypto, registry, pipeline hooks, calendar module + Google provider, OAuth routes, studio ops (behind existing auth).
3. Admin UI in BotPolicyEditor.
4. User creates Google OAuth client + sets envs.
5. E2E against a test business + test Google account; then enable for דיוה אוסט as the pilot.

## Out of scope (v1)

Outlook provider (interface ready), portal-visible meetings list, in-app owner approval screen, rescheduling/cancellation by the customer in chat, multiple meeting types per business, non-primary calendars, per-module billing charges (events are logged, pricing later).
