# Business Overview Dashboard — Spec Draft
**Date:** 2026-04-20
**Status:** Draft — open questions at bottom. Needs a brainstorming pass before implementation.

## Why this matters

The product's core value proposition is *"we save the business owner hours of WhatsApp replying every week."* The dashboard is how that value becomes visible. Without it, an owner sees a WhatsApp agent replying and has no way to quantify the time saved, lead volume, or response quality. The dashboard is also the surface that sells the upsell into the second bundle (lead-management/CRM).

## Guiding principles

1. **Headline metric first, drill-downs second.** On load, one obvious "hours saved this month" number, not a wall of charts. Time-saved is the emotional win.
2. **Every number must be real and live.** No mock data in production, ever. If a number isn't computable today, it's not on the dashboard yet — put it in a "coming soon" list instead of faking it.
3. **Dark WhatsApp palette** to match the existing `wa-studio` admin shell. English chrome, Hebrew content where it appears.
4. **Single-business scoped** for v1. Multi-tenant / cross-business views are a later problem.
5. **Read-mostly.** Writes (status changes, conversation management) live in the CRM add-on (bundle 2), not here.

## Layout sketch

```
┌─────────────────────────────────────────────────────────────────────┐
│  Dashboard  ·  <Business Name>                [date range: 30 days] │
├─────────────────────────────────────────────────────────────────────┤
│  HERO: ⏱️  14h 22m  saved this month                                │
│         (based on ~4 min avg manual reply × 216 conversations)      │
├─────────────────────────────────────────────────────────────────────┤
│  [ conversations this week: 58 ]  [ active now: 3 ]                 │
│  [ hot leads caught: 11 ]         [ avg first-reply: 7s ]           │
├─────────────────────────────────────────────────────────────────────┤
│  Conversations over time  ─────────────────────────────────────    │
│   (bar chart by day, last 30 days)                                  │
├─────────────────────────────────────────────────────────────────────┤
│  Top customer questions (last 30 days)                              │
│   1. כמה זה עולה?               24                                   │
│   2. יש שיעור ניסיון?            18                                   │
│   3. …                                                              │
├─────────────────────────────────────────────────────────────────────┤
│  Recent conversations (last 10) → click to open in CRM view         │
└─────────────────────────────────────────────────────────────────────┘
```

## Proposed metrics

Each metric: what it measures, how it's computed, its source once the G1/G2 gaps from the audit are fixed.

### Hero — "hours saved this month"
- **What:** estimated minutes of the owner's time *not* spent replying, because the agent did it.
- **Formula:** `count(prod_messages where role='agent' AND ts >= start_of_month) × avg_manual_reply_minutes`
- **Default `avg_manual_reply_minutes` = 3** (editable per-business later; can justify with "average WhatsApp reply is 2–5 min, we conservatively picked the middle").
- **Source:** `prod_messages` (after G2 dual-write ships).
- **Why this as hero:** directly ties spend → time saved, which is the thing the owner cares about emotionally and financially.

### Tile 1 — "conversations this week" (primary activity signal)
- **Formula:** `count(distinct prod_conversations.id where started_at >= start_of_week)`
- Source: `prod_conversations`.

### Tile 2 — "active now" (real-time engagement)
- **Formula:** `count(distinct prod_conversations where last_message_at >= now() - 10 minutes)`
- Source: `prod_conversations`.
- Shows a pulsing dot if > 0.

### Tile 3 — "hot leads caught" (conversion signal)
- **What:** conversations that progressed far enough to signal intent.
- **Formula (v1):** `count(prod_conversations where cta_triggered = true AND started_at >= start_of_month)` — leverages the `cta_triggered` flag that WA_03 already sets.
- **Formula (v2):** `count where qualification_progress has ≥3 fields set` — richer once qualification_progress is consistently populated.
- Source: `prod_messages` or `prod_conversations` (whichever table carries `cta_triggered`).

### Tile 4 — "avg first-reply time" (quality signal)
- **Formula:** `avg(first_agent_message.ts - first_user_message.ts)` per conversation in the date range.
- Selling point: "WhatsApp best practices say reply within 10 min → your agent replies in 7 seconds."
- Source: `prod_messages` grouped by `conversation_id`.

### Chart — "conversations over time"
- Bar chart, days on x-axis, conversation count on y-axis, last 30 days default.
- Source: `prod_conversations` grouped by `date_trunc('day', started_at)`.

### Table — "top customer questions"
- What the agent is most often answering.
- **Formula v1 (intent-free):** group customer messages by first ~40-char fuzzy match, count the top 10.
- **Formula v2:** once we tag messages with `detected_intent` (WA_03 already produces it), group by intent.
- Cheapest first version: top 10 `prod_messages.content` where `role='user'` and length < 80, by simple equality count. Ugly but correct. Upgrade later.

### Table — "recent conversations"
- Last 10 conversations, with contact name (from `contacts` once G4 ships), last message, timestamp.
- Each row clicks through to the CRM conversation view (bundle 2).

## Data source summary

| Widget | Reads from | Blocked by gap |
|---|---|---|
| Hero hours saved | `prod_messages` | G2 |
| Conversations this week | `prod_conversations` | G2 |
| Active now | `prod_conversations.last_message_at` | G2 |
| Hot leads caught | `prod_conversations.cta_triggered` | G2 |
| Avg first-reply time | `prod_messages` (first user vs first agent) | G2 |
| Conversations over time | `prod_conversations` | G2 |
| Top customer questions | `prod_messages where role='user'` | G2 |
| Recent conversations | `prod_conversations` + `contacts` | G2, G4 |

**Every widget depends on G2 (prod-table writes) shipping first.** That's the real prerequisite — once prod_conversations + prod_messages get populated, the dashboard can render in parallel with the remaining gaps being filled.

## Rendering / frontend approach

- Built into the existing `wa-studio` React app, accessed via a new route (e.g. `/dashboard/:business_id`) or a new tab in the sidebar.
- No new npm deps for v1: use pure SVG (or Recharts if you're okay with one dep) for the single bar chart. Everything else is text + cards styled with the existing WhatsApp-dark palette.
- Supabase queries run client-side via the existing service-role key (same pattern as `loadFaqItems` / `loadDBState`). No new server needed.
- Refresh cadence: 30s polling for "active now" tile, on-mount for everything else. Revisit when real load shows up.

## Open questions for the user

1. **Scope of v1.** Minimal (hero + 4 tiles + 1 chart), or include the recent-conversations table now? I'd recommend starting minimal and adding the recent-convos table alongside the CRM bundle.
2. **Time-saved formula.** Flat 3 min/message, or let the user configure it, or tiered (e.g., 5 min for long replies, 1 min for "thanks!" acks)? Flat is simplest; configurable is a paid-plan upsell opportunity.
3. **Date-range selector.** Default 30 days, but do we need week / quarter / all-time presets, or a calendar picker? Presets feel right for v1.
4. **Access control.** Is the dashboard a business-owner login (new auth flow via `admin_sessions`), or is it inside `wa-studio`'s current admin shell (implicit trust, single operator)? Affects whether auth work blocks v1 or not.
5. **"Top questions" privacy.** Surfacing actual customer messages on a dashboard is a low privacy risk for B2C businesses but non-trivial for therapists/consultants. Should we show hashed / categorized questions instead of raw text?
6. **Benchmark comparisons.** "You're responding 50% faster than average" — appealing but requires a cross-business dataset. Defer to later.

## Recommended next step

Brainstorm this spec with the user (after they read the audit doc), pin down:
- The v1 scope (likely: hero + 4 tiles + conversations-over-time chart)
- The time-saved formula
- The access/auth model

Then write a plan that gates implementation behind the G1/G2 fixes from the audit.

## Out of scope for this draft

- The CRM / lead-management add-on (bundle 2) — separate spec
- Multi-business roll-up views
- Alerting / push notifications to the business owner
- Any export / CSV / PDF features
- Mobile responsive behavior (desktop first; mobile when it matters)
