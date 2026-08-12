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
// State lives on the EXISTING per-conversation store — the sessions row
// (sessions.coexistence_standdown_until) — no new tables, no timers. Standdown
// expires by time alone in v1; see the report for how an owner re-arm command
// could be added later (a keyword handled in the relay contact gate, which
// already recognises the owner's number).
//
// Every DB-touching path here FAILS SOFT toward today's behaviour: a business
// without the flag (or a database that doesn't have the columns yet) behaves
// exactly as before. Same lazy-import discipline as lib/relay — supabase.js is
// never imported at module top level, so tests run without env.

const DEFAULT_STANDDOWN_MINUTES = 720; // 12h

let db = null; // test seam
export function _setDbForTest(fake) { db = fake; }

async function realDb() {
  const { supabase } = await import('./supabase.js');
  return {
    async getBusinessByPhoneNumberId(phoneNumberId) {
      const { data, error } = await supabase.from('businesses')
        .select('id').eq('wa_phone_number_id', phoneNumberId).maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
    async getCoexistenceSettings(businessId) {
      const { data, error } = await supabase.from('business_profiles')
        .select('coexistence, coexistence_standdown_minutes')
        .eq('business_id', businessId).maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
    // Update-then-insert rather than a blind upsert: an upsert would have to
    // carry the session's other columns and would reset an existing session's
    // stage/mode. A session may genuinely not exist yet — the owner can open
    // a brand-new conversation from the app before the customer ever wrote —
    // and the standdown must survive that customer's FIRST inbound message,
    // so the miss inserts a live session the same way lib/context.js would.
    async setStanddown(sessionId, businessId, untilIso) {
      const { data, error } = await supabase.from('sessions')
        .update({ coexistence_standdown_until: untilIso, updated_at: new Date().toISOString() })
        .eq('session_id', sessionId)
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
    async getStanddown(sessionId) {
      const { data, error } = await supabase.from('sessions')
        .select('coexistence_standdown_until').eq('session_id', sessionId).maybeSingle();
      if (error) throw error;
      return data?.coexistence_standdown_until ?? null;
    },
  };
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
  };
}

// ── Standdown writes (echo side) ─────────────────────────────────────────────
// Called fire-and-forget from the webhook route for every detected echo.
// Gated on the per-business coexistence flag, so existing tenants (flag off,
// or no flag column at all) are untouched. Never throws.
export async function handleOwnerEcho({ phoneNumberId, recipient }, now = new Date()) {
  try {
    if (!phoneNumberId || !recipient) return { standdown: false, reason: 'unaddressable' };
    const d = await getDb();
    const biz = await d.getBusinessByPhoneNumberId(phoneNumberId);
    if (!biz) return { standdown: false, reason: 'no_business' };
    const settings = await d.getCoexistenceSettings(biz.id);
    if (settings?.coexistence !== true) return { standdown: false, reason: 'not_coexistence' };

    const minutes = Number(settings.coexistence_standdown_minutes) > 0
      ? Number(settings.coexistence_standdown_minutes)
      : DEFAULT_STANDDOWN_MINUTES;
    const until = new Date(now.getTime() + minutes * 60_000).toISOString();
    await d.setStanddown(recipient, biz.id, until);
    console.log(`[coexistence] owner replied to ${recipient} — bot standing down until ${until}`);
    return { standdown: true, until };
  } catch (e) {
    console.error('[coexistence] echo handling failed (standdown not set):', e.message);
    return { standdown: false, reason: 'error' };
  }
}

// ── Standdown reads (customer-message side) ──────────────────────────────────
// True only for a parseable future timestamp. Fails SOFT to false — a read
// error (including the column simply not existing yet) must leave every
// non-coexistence tenant exactly as it is today.
export async function standdownActive(sessionId, now = new Date()) {
  try {
    if (!sessionId) return false;
    const until = await (await getDb()).getStanddown(sessionId);
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
// so the decision and the send cannot be reordered by a caller.
export async function sendUnlessStoodDown(sessionId, sendFn, now = new Date()) {
  if (await standdownActive(sessionId, now)) {
    console.log(`[coexistence] reply to ${sessionId} cancelled — owner standdown active`);
    return { cancelled: true };
  }
  await sendFn();
  return { cancelled: false };
}
