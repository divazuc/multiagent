// WhatsApp Coexistence: the owner keeps using the WhatsApp Business APP on the
// same number the Cloud API answers on. Two consequences this module owns:
//
//   1. The Cloud API webhook receives ECHOES of messages the owner sends from
//      the app. An echo is the BUSINESS talking, not a customer — it must never
//      reach the reply pipeline, never create a contact row, never be answered.
//      (Before this, the `messages`-field echo shape — an inbound-looking
//      message whose sender is the business's own number — classified as a
//      normal customer message and would have made the bot answer its own
//      owner.)
//
//   2. OWNER-REPLY STANDDOWN: an echo is also evidence that the owner is
//      personally handling that conversation. For a business with
//      `coexistence: true` (business_profiles), the bot goes silent for that
//      conversation for `coexistence_standdown_minutes` (default 720 = 12h).
//      Customer messages during standdown are still logged and still feed the
//      contact/lead bookkeeping — they just get no bot reply, and a reply
//      already in flight (the human-typing delay) is cancelled at send time.
//
// TWO ECHO CLASSES NEVER ARM THE STANDDOWN (pilot findings, 2026-08-12):
//
//   `self_send` — the echo of a message THIS SERVER sent through the Cloud
//   API (Meta mirrors our own sends back on coexistence numbers). Matched by
//   message id against lib/sent-ids.js. Not the owner talking: no standdown,
//   no lead 'contacted' transition (the pilot's test reminders auto-advanced
//   the owner's own lead row), no transcript bank.
//
//   `auto_reply_suspected` — an echo landing within a short grace window
//   (business_profiles.standdown_echo_grace_seconds, default 25s) of that
//   conversation's LAST INBOUND customer message. The pilot's WhatsApp
//   Business app had an automatic greeting: customer writes → app auto-replies
//   in ~2s → echo → 12h standdown, silencing the bot for the exact lead it was
//   supposed to answer. A human does not answer in under half a minute from a
//   phone; automation does. Logged and dropped.
//
// State lives on the EXISTING per-conversation store — the sessions row
// (sessions.coexistence_standdown_until) — no new tables, no timers. Standdown
// expires by time alone in v1; see the report for how an owner re-arm command
// could be added later (a keyword handled in the relay contact gate, which
// already recognises the owner's number).
//
// SCOPING (pilot finding #1): every standdown read AND write is keyed by the
// (session_id, business_id) PAIR, never by session_id alone. One phone can
// hold live conversations with TWO tenants' bots (the pilot owner's phone
// talks to both the Divaz bot and her own kids bot); an owner echo on one
// business must never silence — or touch the session row of — the other.
// Live evidence: the kids owner's echo wrote its standdown onto the session
// row bound to the DIVAZ business, because the update matched session_id only.
//
// Every DB-touching path here FAILS SOFT toward today's behaviour: a business
// without the flag (or a database that doesn't have the columns yet) behaves
// exactly as before. Same lazy-import discipline as lib/relay — supabase.js is
// never imported at module top level, so tests run without env.

import { isSelfSendId } from './sent-ids.js';

const DEFAULT_STANDDOWN_MINUTES = 720; // 12h
const DEFAULT_ECHO_GRACE_SECONDS = 25;

let db = null; // test seam
export function _setDbForTest(fake) { db = fake; }

// The real store, parameterised on the supabase client so tests can run the
// REAL scoping logic against a fake client (the pilot's wrong-row write lived
// exactly here, below the fake-store seam — never again untestable).
export function _realDbWith(supabase) {
  return {
    async getBusinessByPhoneNumberId(phoneNumberId) {
      const { data, error } = await supabase.from('businesses')
        .select('id').eq('wa_phone_number_id', phoneNumberId).maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
    async getCoexistenceSettings(businessId) {
      let { data, error } = await supabase.from('business_profiles')
        .select('coexistence, coexistence_standdown_minutes, standdown_echo_grace_seconds')
        .eq('business_id', businessId).maybeSingle();
      if (error) {
        // Pre-migration DB — standdown_echo_grace_seconds doesn't exist yet
        // (docs/sql/2026-08-13-sessions-per-business.sql). The standdown
        // itself must keep working: retry with the original columns.
        ({ data, error } = await supabase.from('business_profiles')
          .select('coexistence, coexistence_standdown_minutes')
          .eq('business_id', businessId).maybeSingle());
        if (error) throw error;
      }
      return data ?? null;
    },
    // Update-then-insert rather than a blind upsert: an upsert would have to
    // carry the session's other columns and would reset an existing session's
    // stage/mode. A session may genuinely not exist yet — the owner can open
    // a brand-new conversation from the app before the customer ever wrote —
    // and the standdown must survive that customer's FIRST inbound message,
    // so the miss inserts a live session the same way lib/context.js would.
    //
    // BOTH filters, always: the update targets this business's row for this
    // phone and no other. Pre-migration (unique on session_id alone) a phone
    // whose one session row belongs to ANOTHER business makes the insert
    // violate that constraint — the throw is caught by handleOwnerEcho and the
    // standdown is simply not armed. The other business's session is never
    // touched; that is the whole point.
    async setStanddown(sessionId, businessId, untilIso) {
      const { data, error } = await supabase.from('sessions')
        .update({ coexistence_standdown_until: untilIso, updated_at: new Date().toISOString() })
        .eq('session_id', sessionId)
        .eq('business_id', businessId)
        .select('session_id');
      if (error) throw error;
      if (data?.length) return;
      const { error: insErr } = await supabase.from('sessions').insert({
        session_id: sessionId, business_id: businessId,
        session_mode: 'live', current_stage: 'greeting', setup_completed: true,
        coexistence_standdown_until: untilIso,
      });
      if (insErr) throw insErr;
    },
    // Read side of the same scoping: a standdown armed on the Divaz session
    // must not silence the kids bot for the same phone, and vice versa. With
    // no business to scope by (unknown receiving number) it falls back to the
    // session_id-only read — identical to today for single-business phones.
    async getStanddown(sessionId, businessId = null) {
      let q = supabase.from('sessions')
        .select('coexistence_standdown_until').eq('session_id', sessionId);
      if (businessId) q = q.eq('business_id', businessId);
      const { data, error } = await q.maybeSingle();
      if (error) throw error;
      return data?.coexistence_standdown_until ?? null;
    },
    // The owner's own app reply, banked into the transcript so the leads
    // board's conversation view shows the whole exchange. action 'owner_echo'
    // is the marker the viewer renders as "המאמנת (מהאפליקציה)". Deliberately
    // NOT lib/db.js#saveConversation — that helper requires a user_message and
    // touches the session row; an echo is a bare outbound line.
    async saveEchoMessage({ sessionId, businessId, text }) {
      const { error } = await supabase.from('conversation_messages').insert({
        session_id: sessionId, business_id: businessId,
        user_message: null, agent_response: text,
        stage: 'coexistence', action: 'owner_echo',
      });
      if (error) throw error;
    },
  };
}

async function realDb() {
  const { supabase } = await import('./supabase.js');
  return _realDbWith(supabase);
}

const getDb = async () => db ?? await realDb();

// ── Echo detection (pure) ────────────────────────────────────────────────────
// Liberal on purpose — Meta has shipped SMB echoes in two shapes and the cost
// of missing one is the bot replying to its own owner:
//   A. a dedicated webhook field: change.field === 'message_echoes' (or the
//      older 'smb_message_echoes'), messages under value.message_echoes[]
//   B. the ordinary `messages` field, where the give-away is DIRECTION — the
//      message's `from` is the business's own number (metadata.
//      display_phone_number), i.e. an outbound message came in as inbound.
// Returns null for anything that is not an echo.

const digits = (v) => String(v ?? '').replace(/\D/g, '');

export function detectEcho(body) {
  const change = body?.entry?.[0]?.changes?.[0];
  const value = change?.value;
  if (!value) return null;

  const field = change.field ?? null;
  const echoArr = value.message_echoes ?? value.smb_message_echoes ?? null;
  const isEchoField = field === 'message_echoes' || field === 'smb_message_echoes';

  let msg = null;
  if (isEchoField || Array.isArray(echoArr)) {
    msg = (Array.isArray(echoArr) ? echoArr[0] : null) ?? value.messages?.[0] ?? null;
    if (!msg) return null; // an echo field with nothing in it — nothing to do
  } else {
    // Shape B: outbound direction on the plain messages field.
    const candidate = value.messages?.[0];
    const own = digits(value.metadata?.display_phone_number);
    if (!candidate || !own || digits(candidate.from) !== own) return null;
    msg = candidate;
  }

  // Who the OWNER was talking to — that is the conversation to stand down.
  // Echo payloads carry the customer in msg.to; some shapes put the
  // conversation partner in contacts[0].wa_id instead.
  const recipient = digits(msg.to ?? value.contacts?.[0]?.wa_id) || null;

  return {
    msgId: msg.id ?? null,
    phoneNumberId: value.metadata?.phone_number_id ?? null,
    recipient,
    // What the owner SAID — handleOwnerEcho banks it into the transcript so
    // the leads board's conversation view shows her side too. Null for
    // non-text echoes (media/stickers); those still arm the standdown.
    text: msg.text?.body ?? null,
  };
}

// ── Inbound recency (auto-reply immunity) ────────────────────────────────────
// WHEN did this customer last write to this number — fed by the webhook route
// for every inbound customer message (kind 'message'/'unsupported'), read by
// handleOwnerEcho to spot the app's automatic greeting: an "owner reply"
// landing seconds after the customer's message is automation, not the owner.
// In-memory, same single-instance posture (and bounds discipline) as the
// message-id dedup in lib/wa-webhook.js; a restart in the gap merely restores
// today's behaviour for one echo.

const INBOUND_MAX = 2000;
const lastInbound = new Map(); // `${phone_number_id}|${customer digits}` -> epoch ms

export function noteCustomerInbound({ phoneNumberId, from }, atMs = Date.now()) {
  if (!phoneNumberId || !from) return;
  const key = `${phoneNumberId}|${digits(from)}`;
  lastInbound.delete(key); // refresh insertion order
  lastInbound.set(key, atMs);
  while (lastInbound.size > INBOUND_MAX) {
    lastInbound.delete(lastInbound.keys().next().value); // oldest first
  }
}

const lastInboundAt = (phoneNumberId, customer) =>
  lastInbound.get(`${phoneNumberId}|${digits(customer)}`) ?? null;

export function _clearInboundForTest() { lastInbound.clear(); }

// ── Standdown writes (echo side) ─────────────────────────────────────────────
// Called fire-and-forget from the webhook route for every detected echo.
// Gated on the per-business coexistence flag, so existing tenants (flag off,
// or no flag column at all) are untouched. Never throws.
export async function handleOwnerEcho({ msgId = null, phoneNumberId, recipient, text = null }, now = new Date()) {
  try {
    if (!phoneNumberId || !recipient) return { standdown: false, reason: 'unaddressable' };

    // Our own Cloud API send, mirrored back — not the owner talking. Checked
    // before anything touches the DB: no standdown, no lead transition, no
    // transcript line (the send path already persisted its own message).
    if (msgId && isSelfSendId(msgId)) {
      console.log(`[coexistence] echo ${msgId} is our own API send — self_send, ignoring`);
      return { standdown: false, reason: 'self_send' };
    }

    const d = await getDb();
    const biz = await d.getBusinessByPhoneNumberId(phoneNumberId);
    if (!biz) return { standdown: false, reason: 'no_business' };
    const settings = await d.getCoexistenceSettings(biz.id);
    if (settings?.coexistence !== true) return { standdown: false, reason: 'not_coexistence' };

    // Auto-reply immunity: an echo within the grace window of the customer's
    // own message is the app's automatic greeting, not the owner. Drop it
    // BEFORE the lead 'contacted' transition and the standdown — automation
    // is evidence of nothing. A business can widen the window or set 0 to
    // turn the immunity off (standdown_echo_grace_seconds).
    const graceRaw = Number(settings?.standdown_echo_grace_seconds);
    const graceSeconds = Number.isFinite(graceRaw) && graceRaw >= 0 ? graceRaw : DEFAULT_ECHO_GRACE_SECONDS;
    if (graceSeconds > 0) {
      const inboundMs = lastInboundAt(phoneNumberId, recipient);
      const delta = inboundMs === null ? null : now.getTime() - inboundMs;
      if (delta !== null && delta >= 0 && delta <= graceSeconds * 1000) {
        console.log(`[coexistence] echo to ${recipient} landed ${Math.round(delta / 1000)}s ` +
          `after their message (grace ${graceSeconds}s) — auto_reply_suspected, NOT standing down`);
        return { standdown: false, reason: 'auto_reply_suspected' };
      }
    }

    // Leads module: the owner personally answering IS the "נוצר קשר" signal —
    // advance the lead board before arming the standdown. Awaited because this
    // whole handler already runs detached from the webhook response (nothing
    // customer-facing waits on it), which keeps the write testable and durable;
    // recordOwnerEcho gates itself on the `leads` module and never throws
    // (lib/leads.js), so a tenant without the module — or a database without
    // the table yet — loses nothing, least of all the standdown below.
    try {
      const { recordOwnerEcho } = await import('./leads.js');
      await recordOwnerEcho({ businessId: biz.id, phone: recipient, now });
    } catch (e) {
      console.error('[coexistence] lead echo bookkeeping failed (standdown unaffected):', e.message);
    }

    // Transcript: bank the owner's own line so the board's conversation view
    // shows both sides (action 'owner_echo' → "המאמנת (מהאפליקציה)"). Text
    // echoes only; optional on the seam so pre-existing fixtures — and any
    // db error — cost nothing, least of all the standdown below.
    if (text && typeof d.saveEchoMessage === 'function') {
      try {
        await d.saveEchoMessage({ sessionId: recipient, businessId: biz.id, text });
      } catch (e) {
        console.error('[coexistence] echo transcript write failed (standdown unaffected):', e.message);
      }
    }

    const minutes = Number(settings.coexistence_standdown_minutes) > 0
      ? Number(settings.coexistence_standdown_minutes)
      : DEFAULT_STANDDOWN_MINUTES;
    const until = new Date(now.getTime() + minutes * 60_000).toISOString();
    await d.setStanddown(recipient, biz.id, until);
    console.log(`[coexistence] owner replied to ${recipient} — ${biz.id} bot standing down until ${until}`);
    return { standdown: true, until };
  } catch (e) {
    console.error('[coexistence] echo handling failed (standdown not set):', e.message);
    return { standdown: false, reason: 'error' };
  }
}

// ── Standdown reads (customer-message side) ──────────────────────────────────
// True only for a parseable future timestamp ON THIS BUSINESS'S session row.
// `ref` carries the scope: { businessId } when the caller already resolved it
// (the pipeline), or { phoneNumberId } to resolve it from the receiving number
// (the unsupported-media path). Fails SOFT to false — a read error (including
// the column simply not existing yet) must leave every non-coexistence tenant
// exactly as it is today.
export async function standdownActive(sessionId, ref = {}, now = new Date()) {
  try {
    if (!sessionId) return false;
    const d = await getDb();
    let businessId = ref.businessId ?? null;
    if (!businessId && ref.phoneNumberId && typeof d.getBusinessByPhoneNumberId === 'function') {
      businessId = (await d.getBusinessByPhoneNumberId(ref.phoneNumberId))?.id ?? null;
    }
    const until = await d.getStanddown(sessionId, businessId);
    if (!until) return false;
    const untilMs = new Date(until).getTime();
    return Number.isFinite(untilMs) && untilMs > now.getTime();
  } catch (e) {
    console.error('[coexistence] standdown lookup failed — treating as not stood down:', e.message);
    return false;
  }
}

// The send-time re-check: a reply that was already generated (and sat in the
// human-typing delay) while the owner answered from the app must be dropped,
// not delivered seconds after the owner's own message. Wraps the actual send
// so the decision and the send cannot be reordered by a caller. Scoped to the
// sending business — a standdown on the OTHER tenant's conversation with this
// phone must not cancel this one's reply.
export async function sendUnlessStoodDown(sessionId, businessId, sendFn, now = new Date()) {
  if (await standdownActive(sessionId, { businessId }, now)) {
    console.log(`[coexistence] reply to ${sessionId} cancelled — owner standdown active`);
    return { cancelled: true };
  }
  await sendFn();
  return { cancelled: false };
}
