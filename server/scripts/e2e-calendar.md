# E2E — Calendar module (fake provider, no Google needed)

Run the full booking conversation against a local server with zero Google dependency.
Executed successfully 2026-07-24 (all paths below verified).

## Setup

1. Tables `business_modules` + `module_events` must exist (`wa-studio/docs/sql/2026-07-24-modules.sql` — applied 2026-07-24 via the Supabase Management API).
2. Start the server: `cd server && node --env-file=.env.local index.js`.
3. Enable the module on a test business (Leadz `1037d6c1-...` used originally) via `/studio/rpc`:

```json
{"fn":"updateModule","args":["<biz-id>","calendar",{"enabled":true,"settings":{
  "provider":"fake","mode":"autonomous","min_notice_hours":0,"horizon_days":7,"duration_min":30,
  "weekly":{"sun":[{"from":"10:00","to":"16:00"}],"mon":[{"from":"10:00","to":"16:00"}],
            "tue":[{"from":"10:00","to":"16:00"}],"wed":[{"from":"10:00","to":"16:00"}],
            "thu":[{"from":"10:00","to":"16:00"}],"fri":[{"from":"10:00","to":"13:00"}],"sat":[]}}}]}
```

4. Create a live session: `{"fn":"createSession","args":["e2e_cal_X","live","<biz-id>"]}`.

> ⚠️ **Send Hebrew via Python (urllib/requests), NOT curl from Git Bash** — the Windows
> codepage turns the Hebrew body into `??????` and the model reads garbage.
> Ready-made script: session scratchpad `e2e_calendar.py` (+ `cleanup_e2e.py`).

## Happy path (verified)

1. "אני רוצה לתאם פגישת ייעוץ. מתי יש זמן פנוי השבוע?" → bot offers the **earliest real slot**.
2. "מעולה, [המועד] מתאים לי. קוראים לי דנה כהן, טלפון 0501234567" → bot emits `calendar.book`,
   server log shows `[calendar-fake] createEvent פגישה — דנה כהן <UTC time>` (10:00 IL = 07:00Z in summer),
   customer gets the server confirmation, `module_events` gains an `action.book` row.

## Busy-calendar path (verified)

Restart with `CALENDAR_FAKE_BUSY='[{"start":"<UTC>","end":"<UTC>"}]'` covering a window →
those slots are never offered; asking for one explicitly gets "אין פנוי ב-X, המועד המוקדם ביותר הזמין הוא Y".

## Cleanup (always)

- Disable the module on the test business (`updateModule` with `"enabled":false`).
- `clearSessionData` for each `e2e_cal_*` session.
- **Delete junk FAQ suggestions** created by checkAndSuggestFaq from the test chats
  (`knowledge_items` where `suggested=true` and `created_at` ≥ test start).

## Real-Google E2E (once OAuth client exists)

Set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (+ `PUBLIC_BASE_URL` locally if not prod),
`createConnectLink` → open → consent with a test Google account → settings `provider:"google"` →
rerun the happy path and verify the event in the real calendar, then token-revocation → module status `error`.
