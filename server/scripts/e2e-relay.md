# E2E — Human-rep relay (fake sender, no real WhatsApp traffic)

Drives the whole escalation relay against the **real** database while every
WhatsApp hop is faked: lead escalates → rep is asked → rep quote-replies →
the lead gets the answer in the bot's voice → the escalation reaches `answered`.

Executed successfully 2026-07-28 against the `is_test` tenant **Leadz marketing**
(`1037d6c1-e64f-4672-aa5c-19619ad6b821`), session `e2e_relay_9001` — all steps below verified.

---

## ⚠️ Read before running

> **1. Do not start the server for this run.** `server/index.js:367` sends the agent's
> reply over WhatsApp on *every* live turn (and `:257` sends the after-hours message).
> Anything you push through `/wa-inbound` with a real `session_id` reaches a real phone.
> This runbook deliberately calls the relay functions in-process instead, so no HTTP
> server and no Meta credentials are involved.

> **2. This tenant's existing sessions are real phone numbers.** Leadz currently holds
> one session, `972542898835` — a real person. Never reuse an existing `session_id`;
> always invent a throwaway one that is *not* a phone number (`e2e_relay_9001`).
> Same for the rep: `972500000001` is a throwaway. Note that Leadz's own
> `businesses.whatsapp_number` is `972559489893`, a live WABA line — if you ever set
> the rep contact to that number, `raiseEscalation` refuses to send (own-number guard),
> which is correct but will look like a broken run. The same refusal now applies to
> **any** business's `whatsapp_number`, not just this one's (the bot-to-bot loop
> breaker), and it fails closed — a run that cannot read the `businesses` table sends
> nothing at all.

> **2b. Re-running the script twice without cleanup is a no-op the second time.**
> `raiseEscalation` dedupes on `(business_id, session_id)`: an existing `open` row
> returns the holding line without messaging the rep again. Rerun step 4 (the rep's
> reply) or clean up first, otherwise the second run's empty outbox looks like a
> regression.

> **3. Never overwrite a real rep contact.** `upsertContact` keys on
> `(business_id, role)`, so seeding a throwaway rep on a tenant that already has one
> silently replaces it — and the cleanup would then delete it for good. The script
> **aborts** if a `rep` row already exists, and its cleanup deletes only a row whose
> phone is the throwaway number. Do not remove either guard.

> **4. Hebrew payloads go through Python or Node — never curl.** Git Bash on this
> machine re-encodes the Hebrew body into `??????` and the model reads garbage.
> Write any file containing Hebrew with a normal file write, not a bash heredoc.
> This runbook uses **Node**, not Python: `_setSenderForTest` is an ESM export, so
> only an in-process import can inject the fake sender — which is the whole reason
> this run is safe. Node reads UTF-8 source correctly, so the curl hazard does not apply.

---

## What the fake sender does and does not cover

`relay._setSenderForTest(fn)` replaces **every** outbound hop — to the rep and to
the lead. That is what makes this run safe, and it is also why this run does **not**
exercise the WhatsApp template path: an injected sender short-circuits
`sendToContact` before any template lookup, by design. Template behaviour is covered
by `server/test/relay-template.test.js` (`cd server && npm test`).

Everything else is real: Supabase (`escalations`, `business_contacts`, `sessions`,
`conversation_messages`), the short-code allocator, the reply correlator, and one
real Haiku call for the voice rewrite (≈ ₪0.00 — a few hundred tokens).

---

## Prerequisites

1. `wa-studio/docs/sql/2026-07-25-relay.sql` applied (plus `2026-07-28-escalation-code-unique.sql`
   and `2026-07-28-nudge-settings.sql`). Verified present in prod.
2. `server/.env.local` holds `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ANTHROPIC_API_KEY`.
3. Nothing else — no server, no Meta token, no template.

## The script

Save as a scratchpad file (not in the repo) and run from `server/`:

```bash
cd server && node --env-file=.env.local /path/to/e2e_relay.mjs
```

```js
const S = 'file:///C:/Users/Diva/Documents/Web%20Projects/AI%20Playground/Multi%20agent/server';
const { supabase: sb } = await import(`${S}/lib/supabase.js`);
const relay = await import(`${S}/lib/relay/index.js`);
const contactsMod = await import(`${S}/lib/relay/contacts.js`);

const BIZ_ID = '1037d6c1-e64f-4672-aa5c-19619ad6b821';
const SESSION = 'e2e_relay_9001';   // throwaway — NOT a phone number
const REP_PHONE = '972500000001';   // throwaway — never dialled, the sender is fake

// ── 0. Refuse to run against anything but the test tenant ────────────────────
const { data: biz } = await sb.from('businesses')
  .select('id,name,is_test,whatsapp_number').eq('id', BIZ_ID).maybeSingle();
if (!biz?.is_test) throw new Error(`refusing to run: business ${BIZ_ID} is not is_test`);
if (REP_PHONE === biz.whatsapp_number) throw new Error('rep phone equals the business own number');

// Refuse to clobber a real rep: upsertContact keys on (business_id, role), so an
// existing rep row would be overwritten here and deleted by cleanup — unrecoverably.
const { data: existingRep } = await sb.from('business_contacts')
  .select('id,name,phone').eq('business_id', BIZ_ID).eq('role', 'rep').maybeSingle();
if (existingRep) {
  throw new Error(`refusing to run: this tenant already has a rep contact (${existingRep.name ?? '—'} ${existingRep.phone ?? '—'}). `
    + 'Seeding would overwrite it and cleanup would delete it. Use a different tenant.');
}

// Everything that touches the tenant lives inside try/finally: a throw in the
// middle must never leave a rep contact or a live session behind on a real
// tenant, because a real lead escalating afterwards would try to reach it.
try {
  // ── 1. Seed a live session for the throwaway lead + the throwaway rep ──────
  await sb.from('sessions').upsert({
    session_id: SESSION, business_id: BIZ_ID, session_mode: 'live',
    setup_completed: true, current_stage: 'start',
  }, { onConflict: 'session_id' });
  await contactsMod.upsertContact(BIZ_ID, 'rep', { name: 'E2E Rep', phone: REP_PHONE });

  // ── 2. Fake sender — everything bound for WhatsApp is printed instead ──────
  const outbox = [];
  relay._setSenderForTest(async (msg) => {
    outbox.push(msg);
    console.log(`   → WA[fake] to=${msg.to}\n      ${msg.text.replace(/\n/g, '\n      ')}`);
    return { messages: [{ id: `wamid.E2E${outbox.length}` }] };
  });

  // ── 3. Lead escalates ─────────────────────────────────────────────────────
  const raised = await relay.raiseEscalation({
    business: { id: BIZ_ID, name: biz.name }, session_id: SESSION,
    question: 'אפשר לפרוס את התשלום ל-3 תשלומים?', reason: 'pricing',
    summary: 'מתעניין בחבילת ליווי', leadName: 'דני', persona: { bot_gender: 'female' },
  });
  console.log('holdingLine:', raised?.holdingLine ?? '(null — nothing was asked)');
  const { data: openRow } = await sb.from('escalations')
    .select('id,short_code,status,rep_message_id').eq('business_id', BIZ_ID)
    .eq('session_id', SESSION).maybeSingle();

  // ── 4. Rep quote-replies (context.id = the message we sent them) ──────────
  const consumed = await relay.handleContactMessage({
    business: { id: BIZ_ID, name: biz.name }, from: REP_PHONE,
    text: 'כן, אפשר לפרוס ל-3 תשלומים ללא ריבית.',
    contextId: openRow?.rep_message_id ?? null, persona: { bot_gender: 'female' },
  });

  // ── 5. Final state ────────────────────────────────────────────────────────
  const { data: finalRow } = await sb.from('escalations')
    .select('status,answer,answered_at').eq('business_id', BIZ_ID).eq('session_id', SESSION).maybeSingle();
  console.log('consumed:', consumed, '| escalation:', JSON.stringify(finalRow));
  console.log('lead received:', outbox.find(m => m.to === SESSION)?.text ?? '(nothing)');
} finally {
  // ── 6. Cleanup — runs even if anything above threw ────────────────────────
  // The rep delete is scoped to the throwaway PHONE as well as the role, so a
  // rep row this script did not create can never be removed by it.
  await sb.from('escalations').delete().eq('business_id', BIZ_ID).eq('session_id', SESSION);
  await sb.from('conversation_messages').delete().eq('session_id', SESSION);
  await sb.from('sessions').delete().eq('session_id', SESSION);
  await sb.from('business_contacts').delete()
    .eq('business_id', BIZ_ID).eq('role', 'rep').eq('phone', REP_PHONE);
  console.log('cleaned up: escalation, history, session, throwaway rep contact');
}
```

## Verified output (2026-07-28)

The run below used the same flow. The rep-collision abort and the `try/finally` were
added afterwards in review and have deliberately **not** been re-run against the live
tenant — they are guards around the flow, not changes to it.

```
0. tenant: Leadz marketing | is_test: true | own WABA: 972559489893
1. seeded session e2e_relay_9001 + rep 972500000001
   → WA[fake] to=972500000001
      #1 · דני
      סיכום: מתעניין בחבילת ליווי
      השאלה: אפשר לפרוס את התשלום ל-3 תשלומים?

      ענו להודעה הזו (Reply) כדי שאעביר את התשובה.
3. holdingLine: אני צריכה לבדוק את זה, אעדכן בקרוב.
   escalation row: {"short_code":1,"status":"open","rep_message_id":"wamid.E2E1"}
   → WA[fake] to=e2e_relay_9001
      כן, אני יכולה להציע לך פרוס ל-3 תשלומים ללא ריבית.
   → WA[fake] to=972500000001
      נשלח ✓
4. consumed by the relay (never reaches the sales agent): true
5. escalation: {"status":"answered","answer":"כן, אפשר לפרוס ל-3 תשלומים ללא ריבית.","answered_at":"..."}
   history rows: [{"stage":"escalation_answered", ...}]
6. cleaned up: escalation, history, session, rep contact
```

What to check in that output:

- the rep's message carries the short code `#1`, the lead name, the summary and the question;
- the holding line is returned **only** because the rep was actually reached — a `null` here
  means nothing was sent and the lead correctly falls back to today's escalation sentence;
- `consumed: true` — the rep's own WhatsApp message never reaches the sales agent and never
  creates a `contacts` row for them in the client's lead inbox;
- the answer the lead gets keeps every fact verbatim (`3 תשלומים ללא ריבית`). The rewrite may
  bend the grammar a little — that is tolerated, dropped facts are not;
- `escalations.answer` stores the **raw** human text for the audit trail, not the rewrite;
- one `conversation_messages` row at stage `escalation_answered`, so the next turn sees what
  the lead was actually told.

## Cleanup (always)

The `finally` block does it. Verify with a read-back — the tenant must return to exactly:
`escalations []`, `business_contacts` = one `owner` row with `phone: null`,
`sessions` = only `972542898835`, no `conversation_messages` for the throwaway session.
Leaving a `rep` contact behind is the one that matters: a real lead escalating on this
tenant afterwards would try to reach it.

---

## Templates for the rep hop (pending approval)

Messages **to a contact** are business-initiated and usually land outside WhatsApp's
24h customer-service window, so they go out as approved templates. Messages to the
**lead** stay plain text (the lead has just messaged), and so do the acks the relay
sends back inside the rep's own reply thread.

Two Hebrew templates, submitted together with the pending follow-up template:

| Template | Env var | Body params |
|---|---|---|
| `escalation_notify` | `WHATSAPP_ESCALATION_TEMPLATE` | `{{1}}` short code · `{{2}}` lead name · `{{3}}` summary · `{{4}}` question |
| `escalation_nudge`  | `WHATSAPP_NUDGE_TEMPLATE`      | `{{1}}` short code · `{{2}}` question |

**Until both are approved, leave the env vars unset — locally and on Railway.**
Unset is a hard stop, and that is the intended state:

- `raiseEscalation` sends nothing, returns no message id, and writes **no** escalation row,
  so the lead simply gets today's escalation sentence and is never promised an answer
  nobody was asked for. Logged per escalation, because each one is a distinct lost event;
- `nudgePass` decides **once per pass** that it cannot send, logs one line, and skips every
  send. No `nudge_count` is incremented and no `last_nudge_at` moves — a config error must
  never burn a real rep's reminder budget.

Setting the vars to a template name that is *not yet approved* is worse than leaving them
unset: Graph rejects the send, which is still a correct hard stop, but it burns a Graph
call and buries the reason in the API error instead of the explicit refusal log.

### How an open escalation is guaranteed to end

Three exits, and the third exists precisely because the first two can stall:

1. **Answered** — the rep replies (`handleContactMessage`).
2. **Ceiling** — `nudge_count` reaches `nudge_max_count` and the row is expired. A nudge
   that was *attempted* and rejected by Graph **still counts**, so an unreachable rep
   (number not on WhatsApp, business blocked, template paused by Meta) still walks the
   row to expiry rather than leaving it open forever.
3. **Absolute age cap** — `max(72h, interval × (max + 1))` since `created_at`. Derived, not
   flat, so a business configured for a longer ladder (24h × 4 ≈ 96h) is never cut short.
   This is the backstop for every failure mode that stops the counter advancing at all,
   including the env var being lost in a redeploy after rows were already created.

The cap matters because one immortal `open` row is not merely untidy: `correlate.js` relays
**any** untagged rep reply to the single open row, so a zombie re-routes a rep's next answer
into a dead lead's transcript; and `store.js#nextShortCode` only allocates codes no open row
holds, so zombies leak the 1..99 space until inserts collide and `raiseEscalation` starts
returning `null` for that business.

Nothing schedules `POST /follow-up/process` today, so no pass runs at all until a scheduler
is attached — expiry only happens when something calls it.

### Parameter hygiene

Body parameters are whitespace-collapsed, empties become `—`, and anything over 500
characters is truncated on a word boundary with `…`. Graph rejects a parameter containing a
newline, a tab, a run of four or more spaces, nothing at all, or more than 1024 characters —
and `{{4}}` is the lead's raw question, which can arrive at 4096 characters with newlines in
it. Truncation is cosmetic only: `escalations.question` always keeps the full text.

### Once approved

1. Set `WHATSAPP_ESCALATION_TEMPLATE=escalation_notify` and
   `WHATSAPP_NUDGE_TEMPLATE=escalation_nudge` in `server/.env.local` and on Railway.
2. Re-run the fake-sender script above — it must behave **identically**, because the
   injected sender bypasses templates. This is the regression check that the seam still wins.
3. For a real template send, use a phone **you own** as the rep contact on the Leadz
   tenant, drop the `_setSenderForTest` call, and run only step 3 (escalation raise).
   Expect a real WhatsApp template on that handset and a `wamid.…` in `rep_message_id`.
   Keep the `try/finally` and the rep-collision abort in place; delete the escalation row
   and the rep contact afterwards.
