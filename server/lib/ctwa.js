// Meta Click-to-WhatsApp (CTWA) attribution — the funnel's primary entry.
//
// A CTWA ad opens WhatsApp with the ad's identity attached, and Meta delivers
// that identity EXACTLY ONCE: on the first inbound message of the conversation,
// at entry[0].changes[0].value.messages[0].referral —
//   { source_url, source_id (= the AD id), source_type ('ad'|'post'),
//     headline, body, media_type, ctwa_clid }
// Message #2 onwards carry nothing. `create_quote_lead`, though, may fire many
// turns later ("what's your name and email?" is at least two turns away), so
// the referral cannot be threaded through the pipeline — it is PERSISTED here
// on message #1 and read back at lead-creation time.
//
// STORAGE — module_events, no migration (the bot's Supabase has no migration
// runner). Schema: wa-studio/docs/sql/2026-07-24-modules.sql. Note what it
// actually says, because it is a precondition and not a formality:
// `business_id uuid not null`. So both sides here REQUIRE a business id — a
// write without one can only raise a constraint violation on every insert, and
// a read without one would have to drop the tenant filter and could then match
// another tenant's referral for the same phone. Both refuse, loudly, instead of
// pretending to try. (BUG-013 was exactly this shape and silently disabled a
// whole feature.) In production the id is DIVAZ_BUSINESS_ID, checked at boot by
// lib/booster-client.js#warnOnIncompleteBoosterEnv.
//
// FRESHNESS — maxAgeDays defaults to 30. This is an ATTRIBUTION window in its
// own right, deliberately NOT pegged to any of the funnel's contractual clocks
// (pre-signature link validity, 14 express / 30 questionnaire; post-signature
// quote validity, 30 from the signature; the 14-day payment deadline). Those
// answer "how long may the client still act on this offer"; this one answers
// "is this ad still plausibly what brought them here", and a click older than
// a month is not credibly the cause of today's lead. Change it on attribution
// grounds, never to chase one of those other numbers.
//
// Within the window the LATEST referral wins. That is a deliberate LAST-TOUCH
// policy, not an oversight: a lead who
// clicks a second ad a week later is telling us which creative actually moved
// them, and the booster's reporting question is "which ad produced this order",
// asked at signature time. Please do not "fix" this to first-touch — that is a
// different business question and would need the owner's call, plus a second
// row shape to answer both.
//
// FAIL-SOFT — every exported async function swallows its own failures. Losing
// a tag is a reporting gap; blocking a reply (or a lead) is a lost customer.
//
// FOLLOW-UP (accepted duplication): realDb() below repeats ~15 lines of the
// supabase access in lib/booster-meeting.js. That file was just hardened and is
// deliberately left untouched here. When a third module_events reader appears,
// lift the insert/latest pair into one small shared store and let both call it.
import { normalizeIlPhone } from './booster-client.js';

// module_events store seam — same convention as lib/booster-meeting.js. The
// fake is `{ events: [] }` (rows in insertion order — insertion order stands in
// for created_at); production reads/writes the real table.
let db = null;
export function _setDbForTest(fake) { db = fake; }

const EVENT_TYPE = 'ctwa_referral';

// The fields Meta documents on a referral. Whitelisted rather than spread
// wholesale so the stored row has a predictable shape and a bounded size; add a
// key here (and only here) if Meta ever ships a new one.
const REFERRAL_FIELDS = ['source_url', 'source_id', 'source_type', 'headline', 'body', 'media_type', 'ctwa_clid'];

async function realDb() {
  const { supabase } = await import('./supabase.js');
  return {
    async insertEvent(row) {
      const { error } = await supabase.from('module_events').insert(row);
      if (error) throw error;
    },
    async latestEvent({ businessId, phone }) {
      // created_at exists (NOT NULL DEFAULT now()) — order by it, with id as
      // the tiebreaker for same-timestamp rows. business_id is always filtered,
      // never conditionally: the caller guarantees it is set.
      const { data, error } = await supabase.from('module_events').select('*')
        .eq('business_id', businessId)
        .eq('module_key', 'booster').eq('event_type', EVENT_TYPE)
        .eq('detail->>phone', phone)
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .limit(1);
      if (error) throw error;
      return data?.[0] ?? null;
    },
  };
}

// ── extractReferral ──────────────────────────────────────────────────────────

// Pure, and the gate in front of every database call: ~99% of inbound messages
// are ordinary ones with no `referral` key at all, and they must cost nothing.
// Returns null for anything that does not identify an ad.
export function extractReferral(body) {
  const raw = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.referral;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const ref = {};
  for (const k of REFERRAL_FIELDS) {
    // Values are copied through UNTOUCHED — ctwa_clid in particular is the
    // Conversions-API join key and any "cleanup" (trim, case, encoding) breaks
    // the join silently. Trimming happens later, in the mapper, on copy only.
    if (raw[k] !== undefined && raw[k] !== null) ref[k] = raw[k];
  }
  // An object with none of the known fields identifies nothing — storing it
  // would only produce rows that can never be attributed to an ad.
  return Object.keys(ref).length ? ref : null;
}

// ── recordCtwaReferral ───────────────────────────────────────────────────────

// Never throws. Returns true only when a row was really written.
export async function recordCtwaReferral({ businessId, phone, referral } = {}) {
  // Defensive twin of the caller's own guard: an ordinary message must not
  // reach the store at all.
  if (!referral || typeof referral !== 'object' || !Object.keys(referral).length) return false;
  // Hard precondition, not a fallback — see the header on business_id NOT NULL.
  if (!businessId) {
    console.error('[ctwa] not recording the referral — DIVAZ_BUSINESS_ID is not set (booster env incomplete); the ad that produced this lead is being lost');
    return false;
  }
  // Phones arrive in two shapes — WhatsApp's 972XXXXXXXXX (session_id) and the
  // booster's 05XXXXXXXX. Everything is stored and matched in the normalized
  // 05… form, exactly like lib/booster-meeting.js, so the two always meet.
  const normalized = normalizeIlPhone(phone);
  if (!normalized) {
    console.error('[ctwa] not recording the referral — unparseable phone:', phone);
    return false;
  }
  const row = {
    business_id: businessId,
    module_key: 'booster',
    event_type: EVENT_TYPE,
    // Written explicitly (the column defaults to now() anyway) so the row is
    // self-describing and the freshness window can be applied without a second
    // round-trip.
    created_at: new Date().toISOString(),
    detail: { phone: normalized, ...referral },
  };
  try {
    if (db) { db.events.push(row); db.onInsert?.(row); return true; }
    await (await realDb()).insertEvent(row);
    return true;
  } catch (e) {
    console.error('[ctwa] could not record the referral:', e.message);
    return false;
  }
}

// ── latestCtwaReferral ───────────────────────────────────────────────────────

// The referral object (without the phone key), or null — including on ANY
// failure and on anything older than the window. Never throws: the only caller
// is lead creation, and a lost tag must never cost a lead.
export async function latestCtwaReferral({ businessId = null, phone, maxAgeDays = 30 } = {}) {
  if (!businessId) {
    console.error('[ctwa] referral read skipped — no business id (a read without one would cross tenants)');
    return null;
  }
  const normalized = normalizeIlPhone(phone);
  if (!normalized) return null;
  try {
    const row = await readLatest(businessId, normalized);
    if (!row) return null;
    // Applied in JS on the single latest row rather than in the query, so the
    // in-memory fake and the real table answer identically. Equivalent by
    // construction: if the newest row is outside the window, every older one is
    // too.
    const at = Date.parse(row.created_at ?? '');
    if (!Number.isFinite(at) || Date.now() - at > maxAgeDays * 24 * 60 * 60 * 1000) return null;
    const { phone: _stored, ...referral } = row.detail ?? {};
    return Object.keys(referral).length ? referral : null;
  } catch (e) {
    console.error('[ctwa] referral read failed — treating as no attribution:', e.message);
    return null;
  }
}

async function readLatest(businessId, phone) {
  if (!db) return (await realDb()).latestEvent({ businessId, phone });
  // A fake may supply latestEvent to mimic the real store's async read;
  // otherwise the plain in-memory rows stand in, insertion order for created_at.
  if (typeof db.latestEvent === 'function') return db.latestEvent({ businessId, phone });
  const rows = db.events.filter(r =>
    r.business_id === businessId &&
    r.module_key === 'booster' && r.event_type === EVENT_TYPE &&
    r.detail?.phone === phone);
  return rows.length ? rows[rows.length - 1] : null;
}

// ── toBoosterAttribution ─────────────────────────────────────────────────────

// Pure mapper onto the booster's `attribution` shape (createBoosterLead's
// `utm`). Safe to ship before the booster stores these — it reads named fields
// and drops unknown keys.
//
// Two rules that look like omissions and are not:
//   · utm_source is the CONSTANT 'meta'. The referral does not say whether the
//     click came from Facebook or Instagram, and guessing is how attribution
//     data rots — a wrong surface is worse than a coarse one.
//   · campaign_id is OMITTED ENTIRELY (absent, not null). On the booster side
//     it is matched against campaigns.slug; an ad id there silently misses and
//     mis-credits the lead to nothing.
export function toBoosterAttribution(referral) {
  if (!referral || typeof referral !== 'object') return null;
  const headline = typeof referral.headline === 'string' ? referral.headline.trim() : '';
  return {
    utm_source: 'meta',
    utm_medium: referral.source_type ?? null,       // 'ad' | 'post' — a free paid/organic split
    utm_campaign: null,                             // the referral carries an ad id, never a campaign name
    utm_content: headline || null,
    referrer: referral.source_url ?? null,
    ad_id: referral.source_id ?? null,
    ctwa_clid: referral.ctwa_clid ?? null,          // verbatim — the Conversions-API join key
    attribution_raw: referral,
  };
}
