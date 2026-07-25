# Human-Rep Relay on Escalation — Design

**Date:** 2026-07-25
**Status:** Approved by user (conversation), pending spec review
**Drives:** turning escalation from a label into a real handoff, for clients who have no direct access to the WABA line

## Terminology

Used consistently throughout this document and in the code it describes:

- **Client** — the business owner who buys the bot (Esthetic Clinic, Dragons Kids, דיוה אוסט).
- **Lead** — the person messaging the bot over WhatsApp.
- **Rep** — the human who answers escalations for a client. Usually the client themselves; may be a delegate.

## The problem

Escalation today is a dead end. `server/agents/conversation.js:31-39` returns a single hardcoded sentence, writes an `escalate` flag to two tables, and **notifies nobody**. Verified repo-wide: `persona.escalation_phrase` is read at `conversation.js:32` and **written nowhere**, so every business emits the same fallback string.

That string is `'אני מעביר אותך לנציג שלנו כעת.'` — masculine — while `identityText()` (`conversation.js:98-110`) otherwise enforces feminine Hebrew first-person forms whenever `persona.bot_gender === 'female'`. So a bot configured as female breaks character at exactly the moment it promises a human.

And the promise is empty: the client cannot rescue it, because **the WABA number is operated by the platform**. They cannot open WhatsApp and answer the lead themselves. A bot that says "I'm passing you to a representative" is lying to the lead and invisible to the client.

## Decisions made with the user

| Question | Decision |
|---|---|
| What the lead hears while waiting | A short holding line in the bot's own voice — *"אני צריכה לבדוק את זה, אעדכן בקרוב"*. Never "I'll check with the business owner", never a promise to call back |
| Correlating a rep reply to an escalation | WhatsApp quote-reply (exact, via Meta's `context.id`), short code `#N` as fallback, most-recent as last resort — and when guessing, the bot names the lead it answered |
| Rep does not answer | Nudge the rep every **2 hours** |
| Nudge boundaries | Only inside the business's configured working hours |
| Stopping nudges | The rep can tell the bot to stop |
| Lead goes quiet (separate case) | The normal follow-up sequence, capped per client — out of scope here, see the follow-up spec |
| Guardrails on a human's answer | **The rep's answer is authoritative.** It bypasses content guardrails |

## 1. Data

### 1.1 `escalations` (new table)

Service-role only, like `business_modules` — anon/authenticated REVOKEd.

```sql
create table escalations (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id),
  session_id      text not null,              -- the LEAD's session (their phone)
  short_code      int  not null,              -- small per-business rotating number, shown as #N
  question        text not null,              -- the lead message that triggered escalation
  reason          text,                       -- intent.escalation_reason
  summary         text,                       -- snapshot of the conversation summary at escalation time
  rep_phone       text not null,              -- resolved at creation; kept so a config change cannot orphan an open row
  rep_message_id  text,                       -- WhatsApp id of the message sent to the rep -> exact quote-reply matching
  status          text not null default 'open',  -- open | answered | stopped | expired
  answer          text,
  nudge_count     int  not null default 0,
  last_nudge_at   timestamptz,
  created_at      timestamptz not null default now(),
  answered_at     timestamptz
);

create index escalations_open_idx on escalations (business_id, status, created_at desc);
create index escalations_rep_msg_idx on escalations (rep_message_id);
```

DDL for both new tables (`escalations` here and `business_contacts` in §1.2) is committed as `wa-studio/docs/sql/2026-07-25-relay.sql`, together with the non-destructive owner backfill; applied via the Supabase Management API (the `sbp_` token used for the modules DDL) or the SQL Editor. There is no automated migration runner in this repo.

### 1.2 People — `business_contacts` (new table)

The relay needs to know two humans: the **owner** (the client) and the **rep** who actually answers escalations. Often the same person; sometimes someone running the sales and leads operation on the business's behalf.

**Why a table and not `rep_*` columns.** Contact details are already duplicated across two tables under three names, and the copies have drifted — verified in production:

| Concept | `businesses` | `business_profiles` |
|---|---|---|
| name | `contact_name` = "דיוה", `owner_name` = "Sally Wong" | `contact_name` = "סאלי וונג" |
| email | `contact_email` | `contact_email` |
| phone | `phone` = `054-8139333` | `contact_phone` = `054-8139333` |

Adding `rep_name` / `rep_phone` / `rep_email` would create a third overlapping set — the same failure mode as `archetype` / `business_type` / `business_model` / `business_category`, which now cost more to untangle than they ever saved.

**Do not use `businesses.owner_notification_phone`.** It sounds like the answer and is not: empty on all 5 businesses and read by zero lines of code. The only working owner-notification path is the calendar module's own `settings.owner_notify_phone` (`server/lib/modules/calendar/index.js:120-127`), which is the *send* precedent this feature copies.

```sql
create table business_contacts (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id),
  role         text not null check (role in ('owner','rep')),
  name         text,
  phone        text,          -- digits only, normalised on write
  email        text,
  notes        text,          -- e.g. "מנהל מכירות, זמין א׳–ה׳ בבוקר"
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (business_id, role)
);

create index business_contacts_phone_idx on business_contacts (phone);
```

Service-role only; anon/authenticated REVOKEd, like `business_modules`.

**Resolution rule.** The relay sends to `role='rep'`. If no rep row exists, it falls back to `role='owner'`. If neither has a phone, the relay is **disabled** for that business and escalation keeps today's behaviour.

**Phone normalisation is mandatory on write**, using the rule already applied to lead phones (`server/index.js:457`, `/^\d{10,15}$/`). Production holds `054-8139333` unnormalised in *both* legacy columns; that is exactly why every tenant needed a manual WhatsApp-number fix. The backfill must normalise, not copy.

**Backfill** (one-off, non-destructive): create an `owner` row per business from the best available of `businesses.contact_name` / `owner_name` / `business_profiles.contact_name`, plus email and phone. **Leave every legacy column in place and untouched** — the setup wizard still writes several of them and the clinic carries 98% of production traffic. Retiring the duplicates is real work and is deliberately *not* in this spec.

Nudge settings stay on `business_profiles`, because they are bot behaviour rather than a person:

| Column | Default | Meaning |
|---|---|---|
| `rep_nudge_hours` | 2 | Hours between nudges |
| `rep_nudge_max` | 4 | Ceiling on nudges per escalation (see §5) |

## 2. Flow

1. **Escalation raised.** `conversation.js` detects `intent.escalate`. If the business resolves to a rep phone (§1.2), instead of returning the dead-end sentence it:
   - inserts an `escalations` row with the next `short_code` for that business,
   - snapshots the conversation summary — `contacts.ai_summary` when present. It is generated asynchronously and non-blocking (`index.js:343`), so on a first-message escalation it will be **null or stale**; fall back to the last few turns of `conversation_messages` rather than sending the rep an empty summary,
   - returns a **holding line** to the lead, generated in the bot's configured voice and gender rather than hardcoded.

2. **Rep notified.** The server sends the rep a message and stores the returned WhatsApp message id on the row:

   ```
   #3 · דנה כהן · ליד מאתמול
   סיכום: מתעניינת בטיפול פנים, שאלה על מחירים בעבר.
   השאלה: אפשר לפרוס לתשלומים?

   ענו להודעה הזו (Reply) כדי שאעביר את התשובה.
   ```

3. **Rep answers**, ideally by quoting that message.

4. **Relay.** The server resolves the escalation (§3), marks it `answered`, rewrites the rep's answer into the bot's voice, and sends it to the lead — then the conversation continues normally. The bot never says a human was consulted.

5. **No answer** → nudges (§5).

**Ordering guarantee:** the escalation row and the rep send happen before the holding line goes to the lead. If the rep send fails, the escalation is not created and the lead gets today's fallback behaviour. Never tell a lead you are checking when nobody was asked.

## 3. Correlation

Resolved in this order, on any inbound message from a phone listed in that business's `business_contacts` (either role — see §4):

1. **Quoted message.** Meta's inbound payload carries `context.id` when a message is a reply. Match it against `escalations.rep_message_id`. Exact, no user discipline required.
2. **Leading short code.** Message begins with `#N` (optionally followed by punctuation). Match on `(business_id, short_code, status='open')`.
3. **Single open escalation.** If exactly one is open for that business, use it.
4. **Most recent open**, and the confirmation to the rep **names the lead**: `נשלח לדנה כהן ✓`. A mis-route is then visible in one glance instead of reaching the wrong lead silently.
5. **None open** → the bot tells the rep there is nothing waiting, and does nothing else.

`short_code` is a small per-business counter that recycles (e.g. modulo 99), because it exists to be typed by a human, not to be globally unique. Collisions are avoided by only matching against `status='open'` rows.

## 4. Inbound routing — the sharp edge

Rep messages arrive at the **same WABA number** as every lead's. Without a check, the client's answer is treated as a lead message and the bot replies to its own client as if they were a prospect.

In `server/lib/wa-webhook.js`, before the normal pipeline: look up the sender against `business_contacts.phone` for **any** role, **scoped to the business that owns the receiving `phone_number_id`**. A match routes to the relay handler and returns; the conversation agent is never invoked and no `contacts` row is touched.

Matching on *any* role, not just the resolved rep, is deliberate: if a business has both rows and the owner messages the bot, they must not be answered as if they were a prospect. Answers are accepted from either role — the owner is the ultimate authority for their own business.

Consequences to accept deliberately:

- A person listed in `business_contacts` cannot chat with the bot as a lead from that number. Acceptable, and it must be stated in the admin UI next to the fields.
- The lookup must be scoped per business. A global lookup would let one client's rep number intercept another client's traffic, since several businesses are onboarded behind the same WABA number.

## 5. Nudges

A background pass (the same scheduler the follow-up work introduces — see §9) selects `escalations` where `status='open'`, `last_nudge_at` older than `rep_nudge_hours`, and:

- **Working hours only.** Reuse `isWithinWorkingHours(profile.working_hours)` (`server/index.js:494`, already used as a pre-reply gate at `:218`). Outside hours, skip without incrementing — a lead waiting overnight must not consume the whole nudge budget by 08:00.
- **Ceiling.** Stop at `rep_nudge_max` (default 4) and mark the escalation `expired`. Every nudge outside WhatsApp's 24-hour window is a **billable business-initiated conversation** (`index.js:947` prices these at 0.055 USD vs 0.015 user-initiated, ~3.7×). Unbounded 2-hourly nudging across a quiet weekend is a real cost, not a theoretical one.
- **Stop control.** A rep message sets the escalation to `stopped` when, **after stripping a leading `#N`, the entire remaining message is a stop token** (`עצור`, `די`, `הפסק`, `stop`, case- and punctuation-insensitive). It must be a whole-message match, never a substring: a genuine answer beginning *"די יקר, אבל אפשר לפרוס"* would otherwise be swallowed as a stop command and the lead would get nothing. Scoped by the same correlation rules as an answer, so `#3 עצור` stops one thread and a bare `עצור` stops the most recent — with the same name-the-lead confirmation.

On `expired` or `stopped`, the lead is **not** messaged by this feature. The thread stays open in the inbox for a human. Whether the lead is later re-engaged is the follow-up system's decision, not this one's.

## 6. Guardrails — the human's answer wins

The rep's answer **bypasses content guardrails**, per explicit decision. Rationale: the rep *is* the business. The clinic's no-prices rule exists to stop the *model* inventing prices; when Dr. Krupnik's own rep quotes a price, that is the authoritative answer and stripping it would be absurd.

Implementation constraint — this must be a genuinely separate path, not a flag threaded through the existing validator:

- The relayed text goes through a **voice rewrite only** (tone, gender, length), never through `validate()` (`conversation.js:275`) and never through the `guardrails.forbidden_phrases` check (`:279`).
- The rewrite prompt must be instructed to **preserve the factual content verbatim** — no softening, no adding, no removing figures. A rewrite that "improves" a human's price quote is a correctness bug.
- Every relayed answer is recorded in `escalations.answer` (the raw human text) so the audit trail shows what the human actually said, independent of what was sent.

**Risk accepted:** anyone with the rep's phone can put words in the bot's mouth, unfiltered. Mitigated by the per-business phone scope in §4 and by the audit trail. Worth revisiting if a client ever delegates the rep number outside their own staff.

## 7. WhatsApp templates

Both hops to the rep are business-initiated and will usually fall outside the 24-hour window, so each needs an approved Hebrew template:

1. **Escalation notification** — parameters: short code, lead name, summary, question.
2. **Nudge** — parameters: short code, lead name, elapsed time.

The reply *to the lead* is inside their 24-hour window (they just messaged), so it is a normal free-form send via `sendWhatsAppMessage`.

**Dependency:** `WHATSAPP_FOLLOWUP_TEMPLATE` is unset today and the follow-up template is still awaiting Meta approval. Submit all three templates in one batch to avoid a second approval round trip.

**Hard precondition — do not repeat the follow-up bug.** `index.js:877-893` marks a follow-up `sent` and logs a billing event even when no template is configured. The relay must do the opposite: if the template is missing or the send fails, **do not create the escalation**, do not give the lead a holding line, and fall back to today's behaviour. A relay that silently swallows escalations is worse than no relay.

## 8. Surfaces

**Admin (Studio, `BotPolicyEditor.jsx`)** — an "אנשי קשר" block beside the existing policy controls, with two rows backed by `business_contacts`:

- **בעל העסק** — name, phone, email, notes.
- **נציג אנושי** — name, phone, email, notes, plus the line "אם ריק, האסקלציות יגיעו לבעל העסק".

Below them, nudge interval and nudge ceiling, and a warning that a number listed here cannot also be used as a lead from the same phone.

**Client dashboard** — read-only display of both contacts. Changing who receives escalations is an operator action; a client silently redirecting their own escalations to a wrong number is a support incident.

**Inbox** — open escalations surface as a state on the lead's row so a human can see who is waiting. This reuses the existing status vocabulary; it does **not** introduce a new `contacts.status` value, because `upsertContact`'s ladder currently clobbers any value outside `statusOrder` (`index.js:474-477`) — 9 of 14 production contacts are affected today. Adding a status before that bug is fixed would be adding a value that silently erases itself.

## 9. Dependencies and sequencing

1. **The scheduler** (from the follow-up work) — nudges need a periodic pass. Nothing calls `POST /follow-up/process` today: no `setInterval`, no cron dependency, no Railway cron block. The relay must not ship its own second scheduler.
2. **Approved templates** — §7.
3. **The status-clobber fix** — needed before any inbox state derived from escalations is trustworthy.

The relay can be built against the fake path and tested end-to-end without Meta, using the same approach as the calendar module's fake provider.

## 10. Testing

Unit (`node:test`, following the `_setDbForTest` seam pattern in `lib/modules/engine.js` and `agents/demo.js`):

- Correlation resolves in priority order: quoted id beats short code beats single-open beats most-recent.
- Most-recent fallback returns the lead name for the confirmation.
- Stop vocabulary sets `stopped`, scoped correctly with and without a code.
- Nudge selection skips outside working hours **without** incrementing `nudge_count`.
- Nudge stops at the ceiling and marks `expired`.
- A failed rep send creates no escalation row and produces no holding line.
- The relayed answer is not passed through `validate()` or the forbidden-phrase check.
- A rep-phone sender never reaches the conversation agent and never creates a `contacts` row.

End-to-end (Python, per `server/scripts/e2e-calendar.md` — Hebrew through curl in Git Bash becomes mojibake on this machine): lead escalates → rep receives → rep quote-replies → lead receives the answer in the bot's voice → escalation `answered`. Run on the `is_test` tenant (Leadz, `1037d6c1`), with a throwaway `session_id` — `index.js:331` sends over WhatsApp on every live turn, and that tenant's existing sessions are real phone numbers.

## 11. Non-goals

- Re-engaging the lead after an escalation expires — that is the follow-up system.
- A web inbox for the rep to answer from. The whole premise is that the client lives in WhatsApp.
- Multiple reps, rotation, or on-call schedules. One number per business until a client asks otherwise.
- Fixing the six onboarding fields that never reach the prompt, including `forbidden_claims`. Related, separately specced.

## 12. Open items

- Whether `escalation_phrase` should become a real admin-editable field now that a holding line exists, or be deleted as dead config. It is read once and written nowhere.
- Whether the holding line should be generated per-message by the model (natural, costs a call) or templated per business with gender applied (cheap, slightly stiffer). Recommendation: templated, with the bot's gender and name substituted, since the lead is already waiting and latency matters.
