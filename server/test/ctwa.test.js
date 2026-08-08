// server/test/ctwa.test.js
//
// Meta Click-to-WhatsApp (CTWA) attribution — the funnel's primary entry.
// Meta hands the ad identity to the bot exactly ONCE, on the first inbound
// message of the conversation, at
//   entry[0].changes[0].value.messages[0].referral
// and never again. `create_quote_lead` may fire many turns later, so the
// referral is PERSISTED (module_events, no migration — schema verified against
// wa-studio/docs/sql/2026-07-24-modules.sql) rather than threaded through.
//
// Same seam conventions as booster-meeting.test.js: an in-memory module_events
// store, never a network call or a real Supabase row. All ad ids / clids /
// urls below are FAKE — this repo is public.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ctwa = await import('../lib/ctwa.js');
const {
  extractReferral, recordCtwaReferral, latestCtwaReferral, toBoosterAttribution,
  _setDbForTest,
} = ctwa;

// A realistic-shaped but entirely invented referral.
const REFERRAL = {
  source_url: 'https://fb.me/2fakeAdLink',
  source_id: '120210000000000000',
  source_type: 'ad',
  headline: '  אתר תדמית מוכן תוך שבועיים  ',
  body: 'מיני לנדינג — כל מה שצריך כדי לצאת לדרך',
  media_type: 'image',
  ctwa_clid: 'ARAaBbCcDdEeFfGg_fake_clid_0123456789',
};

const inbound = (msg) => ({
  object: 'whatsapp_business_account',
  entry: [{
    id: 'ENTRY-fake',
    changes: [{
      field: 'messages',
      value: {
        metadata: { phone_number_id: 'PNID-fake' },
        contacts: [{ wa_id: '972521234567' }],
        messages: [msg],
      },
    }],
  }],
});

const ordinaryMessage = { from: '972521234567', id: 'wamid.fake1', type: 'text', text: { body: 'היי, אפשר הצעת מחיר?' } };
const ctwaMessage = { ...ordinaryMessage, referral: REFERRAL };

function freshDb() {
  const db = { events: [] };
  _setDbForTest(db);
  return db;
}

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

test.afterEach(() => { _setDbForTest(null); });

// ── extractReferral (pure) ───────────────────────────────────────────────────

test('extractReferral pulls the ad identity off the first inbound message of a CTWA conversation', () => {
  const ref = extractReferral(inbound(ctwaMessage));
  assert.equal(ref.source_id, '120210000000000000');
  assert.equal(ref.source_type, 'ad');
  assert.equal(ref.source_url, 'https://fb.me/2fakeAdLink');
  assert.equal(ref.media_type, 'image');
  assert.equal(ref.ctwa_clid, 'ARAaBbCcDdEeFfGg_fake_clid_0123456789');
});

test('extractReferral returns null for an ordinary message — the 99% path never reaches the database', () => {
  assert.equal(extractReferral(inbound(ordinaryMessage)), null);
});

test('extractReferral returns null for junk payloads rather than throwing', () => {
  assert.equal(extractReferral(null), null);
  assert.equal(extractReferral({}), null);
  assert.equal(extractReferral({ entry: [] }), null);
  assert.equal(extractReferral({ message: 'hi', session_id: '0521234567' }), null, 'the studio format carries no referral');
  assert.equal(extractReferral(inbound({ ...ordinaryMessage, referral: 'not-an-object' })), null);
  assert.equal(extractReferral(inbound({ ...ordinaryMessage, referral: {} })), null, 'an empty referral identifies no ad');
  assert.equal(extractReferral(inbound({ ...ordinaryMessage, referral: { unknown_field: 'x' } })), null);
});

test('extractReferral keeps ctwa_clid VERBATIM — it is the Conversions-API join key', () => {
  const clid = 'AR z+/=Fake_Clid.With~Odd-Chars';
  const ref = extractReferral(inbound({ ...ordinaryMessage, referral: { source_id: '1', ctwa_clid: clid } }));
  assert.equal(ref.ctwa_clid, clid, 'never trimmed, lowercased, or otherwise "cleaned"');
});

test('extractReferral survives a partial referral (a post referral carries no headline/body)', () => {
  const ref = extractReferral(inbound({ ...ordinaryMessage, referral: { source_id: '999', source_type: 'post' } }));
  assert.equal(ref.source_id, '999');
  assert.equal(ref.source_type, 'post');
  assert.ok(!('headline' in ref), 'absent fields are omitted, never stored as undefined/null noise');
});

// ── recordCtwaReferral ───────────────────────────────────────────────────────

test('recordCtwaReferral writes a booster ctwa_referral row carrying the normalized phone + the referral', async () => {
  const db = freshDb();
  const ok = await recordCtwaReferral({ businessId: 'b1', phone: '0521234567', referral: REFERRAL });
  assert.equal(ok, true);
  assert.equal(db.events.length, 1);
  const row = db.events[0];
  assert.equal(row.business_id, 'b1');
  assert.equal(row.module_key, 'booster');
  assert.equal(row.event_type, 'ctwa_referral');
  assert.ok(row.created_at, 'created_at is written explicitly so the row is self-describing');
  assert.equal(row.detail.phone, '0521234567');
  assert.equal(row.detail.source_id, '120210000000000000');
  assert.equal(row.detail.ctwa_clid, 'ARAaBbCcDdEeFfGg_fake_clid_0123456789');
});

test('recordCtwaReferral normalizes the WhatsApp 972… session id to the booster\'s 05… form', async () => {
  const db = freshDb();
  await recordCtwaReferral({ businessId: 'b1', phone: '972521234567', referral: REFERRAL });
  assert.equal(db.events[0].detail.phone, '0521234567', 'stored 05… so the two phone shapes always meet');
});

test('recordCtwaReferral SKIPS the write when there is no business id (module_events.business_id is NOT NULL)', async () => {
  const db = freshDb();
  const ok = await recordCtwaReferral({ businessId: null, phone: '0521234567', referral: REFERRAL });
  assert.equal(ok, false);
  assert.equal(db.events.length, 0, 'a doomed insert is never attempted — it is skipped with its own log');
});

test('recordCtwaReferral skips an unparseable phone rather than storing an unmatchable row', async () => {
  const db = freshDb();
  assert.equal(await recordCtwaReferral({ businessId: 'b1', phone: 'not-a-phone', referral: REFERRAL }), false);
  assert.equal(await recordCtwaReferral({ businessId: 'b1', phone: null, referral: REFERRAL }), false);
  assert.equal(db.events.length, 0);
});

test('recordCtwaReferral with no referral touches the store at all — the ordinary-message short-circuit', async () => {
  _setDbForTest({ get events() { throw new Error('the store must not be touched'); } });
  assert.equal(await recordCtwaReferral({ businessId: 'b1', phone: '0521234567', referral: null }), false);
  assert.equal(await recordCtwaReferral({ businessId: 'b1', phone: '0521234567' }), false);
});

test('recordCtwaReferral never throws when the store is down — a lost tag must not break the reply pipeline', async () => {
  _setDbForTest({ get events() { throw new Error('store down'); } });
  assert.equal(await recordCtwaReferral({ businessId: 'b1', phone: '0521234567', referral: REFERRAL }), false);
});

// ── latestCtwaReferral ───────────────────────────────────────────────────────

test('latestCtwaReferral returns the referral recorded for that phone', async () => {
  freshDb();
  await recordCtwaReferral({ businessId: 'b1', phone: '0521234567', referral: REFERRAL });
  const ref = await latestCtwaReferral({ businessId: 'b1', phone: '972521234567' });
  assert.equal(ref.source_id, '120210000000000000');
  assert.equal(ref.ctwa_clid, 'ARAaBbCcDdEeFfGg_fake_clid_0123456789');
  assert.ok(!('phone' in ref), 'the stored phone is the key, not part of the referral');
});

test('latestCtwaReferral is deliberately LAST-touch: a newer ad within the window wins', async () => {
  freshDb();
  await recordCtwaReferral({ businessId: 'b1', phone: '0521234567', referral: { ...REFERRAL, source_id: 'OLD-AD' } });
  await recordCtwaReferral({ businessId: 'b1', phone: '0521234567', referral: { ...REFERRAL, source_id: 'NEW-AD' } });
  const ref = await latestCtwaReferral({ businessId: 'b1', phone: '0521234567' });
  assert.equal(ref.source_id, 'NEW-AD');
});

test('latestCtwaReferral ignores a referral older than the 30-day window', async () => {
  const db = freshDb();
  db.events.push({
    business_id: 'b1', module_key: 'booster', event_type: 'ctwa_referral',
    created_at: daysAgo(31), detail: { phone: '0521234567', ...REFERRAL },
  });
  assert.equal(await latestCtwaReferral({ businessId: 'b1', phone: '0521234567' }), null);
  assert.ok(await latestCtwaReferral({ businessId: 'b1', phone: '0521234567', maxAgeDays: 60 }),
    'the window is a parameter, not a hard-coded cliff');
});

test('latestCtwaReferral keeps a referral just inside the 30-day window', async () => {
  const db = freshDb();
  db.events.push({
    business_id: 'b1', module_key: 'booster', event_type: 'ctwa_referral',
    created_at: daysAgo(29), detail: { phone: '0521234567', ...REFERRAL },
  });
  const ref = await latestCtwaReferral({ businessId: 'b1', phone: '0521234567' });
  assert.equal(ref.source_id, '120210000000000000');
});

test('latestCtwaReferral refuses a read with no business id rather than crossing tenants', async () => {
  freshDb();
  await recordCtwaReferral({ businessId: 'b1', phone: '0521234567', referral: REFERRAL });
  assert.equal(await latestCtwaReferral({ businessId: null, phone: '0521234567' }), null);
});

test('latestCtwaReferral never returns another tenant\'s or another phone\'s referral', async () => {
  freshDb();
  await recordCtwaReferral({ businessId: 'b1', phone: '0521234567', referral: REFERRAL });
  assert.equal(await latestCtwaReferral({ businessId: 'b2', phone: '0521234567' }), null);
  assert.equal(await latestCtwaReferral({ businessId: 'b1', phone: '0539999999' }), null);
});

test('latestCtwaReferral returns null (never throws) when the store is unreadable', async () => {
  _setDbForTest({ get events() { throw new Error('store down'); } });
  assert.equal(await latestCtwaReferral({ businessId: 'b1', phone: '0521234567' }), null);
});

test('latestCtwaReferral returns null for an unparseable phone', async () => {
  freshDb();
  assert.equal(await latestCtwaReferral({ businessId: 'b1', phone: 'nope' }), null);
});

// ── toBoosterAttribution (pure mapper) ───────────────────────────────────────

test('toBoosterAttribution maps a referral onto the booster\'s named attribution fields', () => {
  const utm = toBoosterAttribution(REFERRAL);
  assert.equal(utm.utm_medium, 'ad', 'source_type is a free paid/organic split');
  assert.equal(utm.utm_campaign, null, 'the referral carries an ad id, never a campaign name');
  assert.equal(utm.utm_content, 'אתר תדמית מוכן תוך שבועיים', 'the headline, trimmed');
  assert.equal(utm.referrer, 'https://fb.me/2fakeAdLink');
  assert.equal(utm.ad_id, '120210000000000000');
  assert.deepEqual(utm.attribution_raw, REFERRAL, 'the whole referral is kept for later forensics');
});

test('toBoosterAttribution never guesses Facebook vs Instagram — utm_source is always the constant "meta"', () => {
  assert.equal(toBoosterAttribution(REFERRAL).utm_source, 'meta');
  assert.equal(toBoosterAttribution({ source_id: '1', source_type: 'post' }).utm_source, 'meta');
});

test('toBoosterAttribution OMITS campaign_id — an ad id there misses campaigns.slug and mis-credits the lead', () => {
  const utm = toBoosterAttribution(REFERRAL);
  assert.ok(!('campaign_id' in utm), 'the key must be absent, not null');
});

test('toBoosterAttribution passes ctwa_clid through verbatim', () => {
  const clid = 'AR z+/=Fake_Clid.With~Odd-Chars';
  assert.equal(toBoosterAttribution({ ...REFERRAL, ctwa_clid: clid }).ctwa_clid, clid);
});

test('toBoosterAttribution nulls the fields a partial referral does not carry, and returns null for no referral', () => {
  const utm = toBoosterAttribution({ source_id: '999', source_type: 'post' });
  assert.equal(utm.utm_medium, 'post');
  assert.equal(utm.utm_content, null, 'a missing headline is null, never the string "undefined"');
  assert.equal(utm.referrer, null);
  assert.equal(utm.ctwa_clid, null);
  assert.equal(toBoosterAttribution(null), null);
});

// ── index.js capture hook (source pins — the pipeline boots a full server) ───
//
// Same technique as booster-gate-wiring.test.js: index.js cannot be imported
// in a unit test, so the wiring that a unit test cannot see is pinned here.

// WHERE the hook sits is the whole point, so it is pinned against BEHAVIOUR
// (the activation gates' own skip reasons) rather than against a comment.
//
// Each Step 2b pre-check `return`s straight out of the pipeline. Banking the
// referral below them would destroy attribution for exactly the clicks most
// likely to happen — ad traffic skews to evenings and nights, which is when
// answer_after_hours fires — and it would do it silently. A referral we banked
// but chose not to reply to is recoverable; one we never wrote is gone forever.
// Capturing is pure data preservation with no customer-visible effect, so it
// belongs above every decision about WHETHER to answer.
test('index.js banks the CTWA referral ABOVE every activation gate — an after-hours ad click is still attributed', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(src, /extractReferral/, 'the pure extractor gates the DB write');
  assert.match(src, /recordCtwaReferral\(/, 'the capture goes through the tested recorder');

  const ctwaIdx = src.indexOf('recordCtwaReferral(');
  assert.ok(ctwaIdx > 0);
  // Matched on `skipped: '<reason>'` — the literal each gate hands completeRun
  // — rather than the bare reason, which also occurs in the prose explaining
  // why the hook sits where it does.
  for (const gate of ['agent_inactive', 'after_hours', 'known_contact', 'business_initiated']) {
    const gateIdx = src.indexOf(`skipped: '${gate}'`);
    assert.ok(gateIdx > 0 && ctwaIdx < gateIdx,
      `the referral must be banked before the ${gate} gate can return out of the pipeline`);
  }
  assert.ok(ctwaIdx < src.indexOf('buildModulesContext('),
    'and therefore also above the modules-context step');
});

test('index.js still guards the capture on live mode + a business id, and never awaits it', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const ctwaIdx = src.indexOf('recordCtwaReferral(');
  const block = src.slice(Math.max(0, ctwaIdx - 1200), ctwaIdx + 400);

  assert.match(block, /session_mode === 'live' && business_id/,
    'module_events.business_id is NOT NULL — the capture stays gated on a resolved business id');
  assert.match(block, /extractReferral\(body\)/,
    'the pure extractor still short-circuits ordinary messages before any DB call');

  // Fire-and-forget: the capture must never be awaited into the reply path,
  // and must never leave an unhandled rejection behind.
  assert.doesNotMatch(src.slice(ctwaIdx - 20, ctwaIdx + 400), /await\s+recordCtwaReferral/,
    'the reply must never wait on an attribution write');
  assert.match(src.slice(ctwaIdx, ctwaIdx + 400), /\.catch\(/,
    'fire-and-forget still has to swallow its own rejection');
});
