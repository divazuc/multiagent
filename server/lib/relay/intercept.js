// The gate in /wa-inbound that keeps a listed contact's message (rep or owner)
// out of the conversation agent. Rep messages arrive at the SAME WABA number as
// every lead's, so without this the client's own answer is treated as a lead
// message: the bot pitches its client and files them in the client's own lead
// inbox.
//
// FAILS CLOSED, deliberately. This lived inline in index.js, where a failed
// business lookup left `biz` null, skipped the relay block and ran the pipeline
// — a transient DB hiccup was enough to make the bot sell to its own rep. A
// lookup ERROR is not evidence that the sender is a lead; it is evidence that
// we do not know, and the feature's premise is that a rep must never be treated
// as a lead. Losing one reply to a real lead on a DB blip is recoverable; the
// other direction is a support incident with the client watching.
//
// Same lazy-import discipline as the rest of lib/relay: supabase.js is only
// imported inside the call, never at module top level.
let db = null; // test seam
export function _setDbForTest(fake) { db = fake; }

let handler = null; // test seam for handleContactMessage
export function _setHandlerForTest(fn) { handler = fn; }

async function realDb() {
  const { supabase } = await import('../supabase.js');
  return {
    async getBusinessByPhoneNumberId(phoneNumberId) {
      const { data, error } = await supabase.from('businesses')
        .select('id, name').eq('wa_phone_number_id', phoneNumberId).maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
    async getPersona(businessId) {
      const { data, error } = await supabase.from('business_profiles')
        .select('persona').eq('business_id', businessId).maybeSingle();
      if (error) throw error;
      return data?.persona ?? null;
    },
  };
}

// Returns TRUE when the message must not reach runAgentPipeline — either the
// relay consumed it, or we could not establish that it is safe to hand over.
export async function interceptContactMessage({ phoneNumberId, from, text, contextId }) {
  // Meta always sends metadata.phone_number_id. Without it there is nothing to
  // scope a per-business contact lookup to, and a GLOBAL phone lookup is
  // explicitly forbidden (design §4: it would let one client's rep intercept
  // another client's traffic). Nothing to check, so nothing is claimed.
  if (!phoneNumberId) {
    console.warn('[wa-inbound] no phone_number_id on the payload — the contact gate cannot be scoped');
    return false;
  }

  const store = db ?? await realDb();

  let biz;
  try {
    biz = await store.getBusinessByPhoneNumberId(phoneNumberId);
  } catch (e) {
    console.error('[wa-inbound] business lookup failed — refusing to run the pipeline for an unverified sender:', e.message);
    return true;
  }
  // A clean not-found: no business owns this receiving number. Nothing to scope
  // the contact lookup to and nothing was learned about the sender either way;
  // the pipeline's own context load will fail this message on its merits.
  if (!biz) return false;

  // Cosmetic only — persona sets the bot's gender in the acks. A failure here
  // must not decide whether a rep is treated as a lead.
  let persona = null;
  try {
    persona = await store.getPersona(biz.id);
  } catch (e) {
    console.error('[wa-inbound] persona lookup failed — continuing with the default voice:', e.message);
  }

  try {
    const handle = handler ?? (await import('./index.js')).handleContactMessage;
    return await handle({
      business: { id: biz.id, name: biz.name ?? '' },
      from, text, contextId, persona,
    });
  } catch (e) {
    console.error('[wa-inbound] contact handling failed — refusing to run the pipeline for an unverified sender:', e.message);
    return true;
  }
}
