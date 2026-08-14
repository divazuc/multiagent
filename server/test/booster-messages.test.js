// server/test/booster-messages.test.js
//
// Task 15 (seam 2) — the bot turns a booster outbox event into the Hebrew
// WhatsApp copy the client actually reads. Every known event must produce a
// non-empty message that carries the payload's key fact (the link, the quote
// number, ...); an unknown event must return null so the route can ack and
// skip it rather than retry forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boosterMessageFor, toWaNumber } from '../lib/booster-messages.js';

const lead = { name: 'דנה כהן', phone: '0521234567' };

// ── THREE CLOCKS WEAR THE SAME DIGITS — never unify them ─────────────────────
//
//   1. PRE-SIGNATURE LINK validity — what `valid_days` carries, and what
//      send_personal_link tells the client. 14 days on the express track,
//      30 on questionnaire/self_serve. Clock starts when the link is issued.
//   2. POST-SIGNATURE QUOTE validity — 30 days, measured FROM THE SIGNATURE.
//      Nothing in this file carries it; it lives in the KB copy.
//   3. PAYMENT deadline — 14 days. Contractual, and confirmed unchanged.
//
// A previous pass read (2) as if it were (1) and moved this fallback to 30.
// The fix is not just the digit: every string that states one of these now
// names the event it counts from, so the next reader cannot repeat the
// substitution.

test('send_personal_link carries the link url and greets the lead by first name', () => {
  const msg = boosterMessageFor('send_personal_link',
    { link_url: 'https://booster.divdev.co/e/abc123', valid_days: 14 }, lead);
  assert.ok(msg && msg.length > 0);
  assert.match(msg, /https:\/\/booster\.divdev\.co\/e\/abc123/);
  assert.match(msg, /14/, 'the payload\'s own window is what the client is told');
  assert.match(msg, /דנה/, 'greets by first name, not the full name');
  assert.doesNotMatch(msg, /דנה כהן/, 'must use the first name only');
});

test('send_personal_link carries a questionnaire-track 30-day link window when the payload says so', () => {
  const msg = boosterMessageFor('send_personal_link', { link_url: 'https://x/y', valid_days: 30 }, lead);
  assert.match(msg, /30/, 'the fallback is express-shaped, but the payload always wins');
});

// Clock 1, express default. NOT clock 2 — the post-signature quote window is
// 30 days and is a different measurement of a different thing.
test('send_personal_link falls back to 14 valid days — the PRE-signature link window, not the post-signature quote window', () => {
  const msg = boosterMessageFor('send_personal_link', { link_url: 'https://x/y' }, lead);
  assert.match(msg, /14/);
  assert.doesNotMatch(msg, /30/, 'the 30-day quote validity must never leak into the link copy');
});

test('send_signed_summary carries the quote number and a formatted total', () => {
  const msg = boosterMessageFor('send_signed_summary', { quote_number: 'Q-1042', total: 500 }, lead);
  assert.ok(msg && msg.length > 0);
  assert.match(msg, /Q-1042/);
  assert.match(msg, /₪500/);
});

// v3 (meeting-before-payment): the bot schedules the characterization meeting
// itself, in-conversation — meeting_link is only a fallback for channels
// without the bot. See docs/booster-meeting-scheduling-handoff.md.
test('send_signed_summary with a meeting_link invites scheduling via that link', () => {
  const msg = boosterMessageFor('send_signed_summary',
    { quote_number: 'Q-1042', total: 500, meeting_link: 'https://cal.divdev.co/dz-1042' }, lead);
  assert.match(msg, /פגישת אפיון/);
  assert.match(msg, /https:\/\/cal\.divdev\.co\/dz-1042/);
});

test('send_signed_summary without a meeting_link invites scheduling in the chat instead of a link', () => {
  const msg = boosterMessageFor('send_signed_summary', { quote_number: 'Q-1042', total: 500 }, lead);
  assert.match(msg, /פגישת אפיון/);
  assert.match(msg, /נתאם כאן/);
  assert.doesNotMatch(msg, /https?:\/\//, 'no link when the payload has none');
});

test('send_signed_summary treats an empty-string meeting_link as absent', () => {
  const msg = boosterMessageFor('send_signed_summary', { quote_number: 'Q-1042', total: 500, meeting_link: '' }, lead);
  assert.match(msg, /נתאם כאן/);
});

test('send_meeting_reminder references the order and offers the link when present', () => {
  const msg = boosterMessageFor('send_meeting_reminder',
    { quote_number: 'Q-1042', meeting_link: 'https://cal.divdev.co/dz-1042' }, lead);
  assert.ok(msg && msg.length > 0);
  assert.match(msg, /Q-1042/);
  assert.match(msg, /https:\/\/cal\.divdev\.co\/dz-1042/);
  assert.match(msg, /פגישת/);
});

test('send_meeting_reminder omits the order reference gracefully when quote_number is null', () => {
  const msg = boosterMessageFor('send_meeting_reminder', { quote_number: null }, lead);
  assert.ok(msg && msg.length > 0);
  assert.match(msg, /נתאם כאן/);
  assert.doesNotMatch(msg, /null/);
});

test('send_meeting_reminder never mentions payment', () => {
  const withLink = boosterMessageFor('send_meeting_reminder',
    { quote_number: 'Q-1042', meeting_link: 'https://cal.divdev.co/dz-1042' }, lead);
  const withoutLink = boosterMessageFor('send_meeting_reminder', { quote_number: 'Q-1042' }, lead);
  for (const msg of [withLink, withoutLink]) {
    assert.doesNotMatch(msg, /תשלום/, 'meeting reminder must not talk about payment');
    assert.doesNotMatch(msg, /₪/, 'meeting reminder must not carry a price');
  }
});

// C1 fix: the booster now formats app_settings.express_payment_details (a raw JSON
// string) into Hebrew lines BEFORE it reaches the outbox (lib/express/payment-details.ts)
// — the bot stays dumb and just interpolates the already-formatted string verbatim. Feed
// the actual multi-line shape the booster now sends, and assert no raw JSON leaks through.
test('send_payment_details carries the quote number and the formatted (multi-line) payment details when provided', () => {
  const formatted = 'העברה בנקאית: בנק פועלים · סניף 123 · ח-ן 456\nביט: 050-1234567\nפייבוקס: paybox.co.il/pwtest';
  const msg = boosterMessageFor('send_payment_details',
    { quote_number: 'Q-1042', payment_details: formatted }, lead);
  assert.ok(msg && msg.length > 0);
  assert.match(msg, /Q-1042/);
  assert.match(msg, /העברה בנקאית: בנק פועלים · סניף 123 · ח-ן 456/);
  assert.match(msg, /ביט: 050-1234567/);
  assert.match(msg, /פייבוקס: paybox\.co\.il\/pwtest/);
  assert.doesNotMatch(msg, /[{}]/, 'must never leak raw JSON braces into the WhatsApp message');
});

test('send_payment_details falls back to the total when payment_details is missing', () => {
  const msg = boosterMessageFor('send_payment_details', { quote_number: 'Q-1042', total: 500 }, lead);
  assert.ok(msg && msg.length > 0);
  assert.match(msg, /Q-1042/);
  assert.match(msg, /₪500/);
});

test('send_payment_reminder carries the quote number and total', () => {
  const msg = boosterMessageFor('send_payment_reminder', { quote_number: 'Q-1042', total: 500 }, lead);
  assert.ok(msg && msg.length > 0);
  assert.match(msg, /Q-1042/);
  assert.match(msg, /₪500/);
});

test('send_expiry_notice returns a non-empty Hebrew string even with no payload facts', () => {
  const msg = boosterMessageFor('send_expiry_notice', {}, lead);
  assert.ok(msg && msg.length > 0);
  assert.match(msg, /[֐-׿]/, 'must be Hebrew copy');
});

// I1: the same event carries very different facts depending on `reason` — a client
// who never signed vs. one who paid, sent some materials, then went dark past the
// 30-day window (whose payment converts to a one-year credit rather than a refund,
// per the super-contract's clause 26). Sending the generic "your link expired" text
// to the second group would be actively wrong (they don't need a new link, they need
// to know what happened to money they already paid).
// BOTH unsigned_* cutoffs are LIVE — neither is legacy. They are the same
// clock (1, pre-signature link validity) on two tracks: express expires at 14
// days, questionnaire/self_serve at 30. Both are "your link expired" and both
// take the generic text.
test('send_expiry_notice: both live link cutoffs — unsigned_14d (express) and unsigned_30d (questionnaire) — return the generic link-expired text', () => {
  const generic = boosterMessageFor('send_expiry_notice', {}, lead);
  for (const reason of ['unsigned_14d', 'unsigned_30d']) {
    const msg = boosterMessageFor('send_expiry_notice', { reason }, lead);
    assert.match(msg, /פג תוקף/, `reason=${reason} is a pre-signature link expiry`);
    assert.equal(msg, generic,
      `reason=${reason} must stay byte-for-byte the generic copy — no closure/refund language may leak onto a lead who never signed`);
    assert.doesNotMatch(msg, /₪/, 'a lead who never signed neither owes nor is owed money');
  }
});

// The catch-all `else` IS the contract, not a convenience: the list of
// graduated cutoffs belongs to the booster and changes without this repo (a
// future unsigned_60d, a payload with no reason at all). Anything that is not
// a known materials_* closure is a plain expired link and must never fall
// through unhandled — including a materials-SHAPED reason this repo has never
// heard of, which must not be pattern-matched into a closure notice on a guess.
test('send_expiry_notice: any UNRECOGNIZED reason still returns the generic link-expired text', () => {
  const generic = boosterMessageFor('send_expiry_notice', {}, lead);
  for (const reason of ['unsigned_60d', 'some_future_cutoff', 'materials_6m', '', null, undefined]) {
    const msg = boosterMessageFor('send_expiry_notice', { reason }, lead);
    assert.match(msg, /פג תוקף/, `reason=${reason} must not fall through unhandled`);
    assert.equal(msg, generic, `reason=${reason} takes the same generic copy, unchanged`);
  }
  // A refund the bot was never told how to frame is not a licence to improvise:
  // an unknown reason stays generic even when money rides along in the payload.
  const stray = boosterMessageFor('send_expiry_notice',
    { reason: 'materials_9m', refund: 'הסכום ששולם מוחזר בניכוי דמי טיפול בסך 250 ₪ + מע"מ' }, lead);
  assert.match(stray, /פג תוקף/);
  assert.doesNotMatch(stray, /₪/, 'an unhandled reason must not leak a refund sentence it has no copy for');
});

test('send_expiry_notice: materials_30d reason acknowledges the closed order + one-year credit and invites renewal', () => {
  const msg = boosterMessageFor('send_expiry_notice', { reason: 'materials_30d' }, lead);
  assert.match(msg, /קרדיט/);
  assert.match(msg, /שנה/);
  assert.doesNotMatch(msg, /פג תוקף/, 'must not reuse the generic expired-link text for a paying client');
});

// ── materials_3m: the contractual 3-month materials window ───────────────────
//
// The booster now closes a PAID order whose materials never arrived within the
// 3 months the contract gives (the KB answer seeded by
// scripts/update-divaost-from-spec.mjs states the same policy: "אם החומרים לא
// הועברו תוך 3 חודשים — ההזמנה נסגרת עם החזר בניכוי דמי טיפול"). Two things
// make this its own case rather than a shade of the generic notice:
//   • nothing about a LINK expired — the client paid; telling them otherwise
//     is simply false, and buries the fact that money is owed back to them;
//   • the payload carries `refund`, a Hebrew sentence the BOOSTER formatted.
// That sentence is interpolated verbatim — the identical iron rule as
// send_payment_details' payment_details and send_start_date's non-ISO date. The
// bot owns no money copy of its own here: every ₪ in the message is one the
// booster put there.
const REFUND_SENTENCE = 'הסכום ששולם מוחזר בניכוי דמי טיפול בסך 250 ₪ + מע"מ'; // fake fixture

test('send_expiry_notice: materials_3m renders the closure message with the booster\'s refund sentence verbatim', () => {
  const msg = boosterMessageFor('send_expiry_notice', { reason: 'materials_3m', refund: REFUND_SENTENCE }, lead);
  assert.ok(msg && msg.length > 0);
  assert.ok(msg.includes(REFUND_SENTENCE),
    'the booster pre-formats the Hebrew — the bot interpolates it verbatim, never reformats or re-derives it');
  assert.match(msg, /נסגרה/, 'says plainly that the order was closed');
  assert.match(msg, /שלושת החודשים/, 'names the contractual window that lapsed');
  assert.match(msg, /דיוה/, 'the voice is דיוה, not a corporate "אנחנו"');
  assert.doesNotMatch(msg, /אנחנו/);
  assert.doesNotMatch(msg, /פג תוקף/, 'a client who PAID must never be told their link expired');
  assert.doesNotMatch(msg, /undefined|null/);
});

test('send_expiry_notice: materials_3m without a refund field never invents an amount', () => {
  const msg = boosterMessageFor('send_expiry_notice', { reason: 'materials_3m' }, lead);
  assert.ok(msg && msg.length > 0);
  assert.match(msg, /נסגרה/, 'the closure itself is the bot\'s own fact and still gets said');
  assert.match(msg, /דיוה/, 'points at who will send the closure details');
  assert.doesNotMatch(msg, /₪/, 'with no booster sentence there is no amount to print');
  assert.doesNotMatch(msg, /\d/, 'and none to invent — not a digit the booster did not send');
  assert.doesNotMatch(msg, /undefined|null/);
});

// Mirrors the ₪ guard the materials/start/live test uses, minus the one string
// the booster authored: strip the verbatim sentence, and nothing with a ₪ in it
// may be left over.
test('send_expiry_notice: the materials_3m closure prints no ₪ of the bot\'s own', () => {
  const msg = boosterMessageFor('send_expiry_notice', { reason: 'materials_3m', refund: REFUND_SENTENCE }, lead);
  assert.doesNotMatch(msg.replace(REFUND_SENTENCE, ''), /₪/,
    'every ₪ in the closure came from the booster; the bot originates none');
  assert.equal(msg.split('₪').length - 1, 1, 'exactly the one ₪ the booster sent, no more');
});

// ── T8 (funnel track 1): the materials-stage templates ───────────────────────
// Payload shapes verified against the booster repo: send_materials_checklist
// carries { quote_number, folder_url, materials_doc_url, content_doc_url,
// page_url } (meeting-before-payment plan Task 9 + client personal area,
// vault spec 19 phase A); ack_materials / notify_live carry nothing;
// send_start_date carries { start_date: 'YYYY-MM-DD' }.

test('send_materials_checklist carries the links and quote number, skipping any empty link line', () => {
  const msg = boosterMessageFor('send_materials_checklist', {
    quote_number: 'DZ-2026-1042',
    folder_url: 'https://drive.google.com/drive/folders/fake123',
    materials_doc_url: 'https://docs.google.com/document/d/fake-materials',
    content_doc_url: '', // empty ⇒ the whole line is skipped, not printed blank
  }, lead);
  assert.ok(msg && msg.length > 0);
  assert.match(msg, /DZ-2026-1042/);
  assert.match(msg, /https:\/\/drive\.google\.com\/drive\/folders\/fake123/);
  assert.match(msg, /https:\/\/docs\.google\.com\/document\/d\/fake-materials/);
  assert.doesNotMatch(msg, /תכנים.*:\s*($|\n)/m, 'an empty link must not leave a dangling labelled line');
  assert.match(msg, /סיימתי/, 'tells the client how to declare completion in chat');
});

test('send_materials_checklist with no links at all (today\'s payload) still opens the materials stage', () => {
  const msg = boosterMessageFor('send_materials_checklist', { package_id: 'landing' }, lead);
  assert.ok(msg && msg.length > 0);
  assert.match(msg, /[֐-׿]/, 'Hebrew copy');
  assert.match(msg, /סיימתי/);
  assert.doesNotMatch(msg, /https?:\/\//, 'no invented links');
  assert.doesNotMatch(msg, /null|undefined/);
});

test('send_materials_checklist with page_url leads with the project page and points at its button, not the chat keyword', () => {
  const msg = boosterMessageFor('send_materials_checklist', {
    quote_number: 'DZ-2026-1042',
    folder_url: 'https://drive.google.com/drive/folders/fake123',
    materials_doc_url: 'https://docs.google.com/document/d/fake-materials',
    content_doc_url: 'https://docs.google.com/document/d/fake-content',
    page_url: 'https://divazuc.com/project/aabbcc',
  }, lead);
  assert.ok(msg && msg.length > 0);
  const pageIdx = msg.indexOf('https://divazuc.com/project/aabbcc');
  const folderIdx = msg.indexOf('https://drive.google.com/drive/folders/fake123');
  assert.ok(pageIdx > -1 && folderIdx > -1 && pageIdx < folderIdx, 'the project page is the FIRST link');
  assert.match(msg, /עמוד הפרויקט/);
  assert.match(msg, /סיימתי לערוך תכנים/, 'points at the page button (spec 19 decision)');
  assert.doesNotMatch(msg, /כתבו לי כאן "סיימתי"/, 'the chat keyword is no longer the instructed path');
});

test('send_deliverables_ready links the project page; without page_url no dead link line is printed', () => {
  const msg = boosterMessageFor('send_deliverables_ready', {
    quote_number: 'DZ-2026-1042', page_url: 'https://divazuc.com/project/aabbcc',
  }, lead);
  assert.match(msg, /סקיצות/);
  assert.match(msg, /https:\/\/divazuc\.com\/project\/aabbcc/);
  assert.doesNotMatch(msg, /₪|תשלום/);

  const bare = boosterMessageFor('send_deliverables_ready', {}, lead);
  assert.ok(bare && bare.length > 0);
  assert.doesNotMatch(bare, /https?:\/\//, 'no invented links');
  assert.doesNotMatch(bare, /null|undefined/);
});

test('ack_materials acknowledges without ever claiming the materials were approved', () => {
  const msg = boosterMessageFor('ack_materials', {}, lead);
  assert.ok(msg && msg.length > 0);
  assert.doesNotMatch(msg, /אושר/, 'only Diva approves — the bot never announces an approval');
  assert.match(msg, /דיוה/, 'names who actually reviews');
});

test('send_start_date presents the start date in IL format and passes a non-ISO date through verbatim', () => {
  const msg = boosterMessageFor('send_start_date', { start_date: '2026-08-20' }, lead);
  assert.match(msg, /20\.08\.2026/);
  const odd = boosterMessageFor('send_start_date', { start_date: 'מחר' }, lead);
  assert.match(odd, /מחר/, 'a booster payload string is interpolated verbatim, never "fixed"');
});

test('notify_live announces the work has started without inventing details', () => {
  const msg = boosterMessageFor('notify_live', {}, lead);
  assert.ok(msg && msg.length > 0);
  assert.match(msg, /[֐-׿]/);
  assert.doesNotMatch(msg, /https?:\/\//, 'no payload facts — no invented links');
});

test('ack_payment_proof deliberately stays null — the bot already acked the screenshot in chat', () => {
  // payment-proof.js replies 'קיבלתי, בודקת ומעדכנת 🙏' at upload time; a
  // second ack from the booster's outbox would double-message the client.
  assert.equal(boosterMessageFor('ack_payment_proof', {}, lead), null);
});

test('the materials/start/live templates never print a ₪ or talk about payment', () => {
  const msgs = [
    boosterMessageFor('send_materials_checklist', { quote_number: 'DZ-1', folder_url: 'https://x/f' }, lead),
    boosterMessageFor('ack_materials', {}, lead),
    boosterMessageFor('send_start_date', { start_date: '2026-08-20' }, lead),
    boosterMessageFor('notify_live', {}, lead),
  ];
  for (const msg of msgs) {
    assert.ok(msg);
    assert.doesNotMatch(msg, /₪/, 'the bot never prints prices of its own');
    assert.doesNotMatch(msg, /תשלום/, 'the materials stage never re-opens payment talk');
  }
});

test('an unknown event returns null so the caller acks and skips rather than retries forever', () => {
  assert.equal(boosterMessageFor('some_future_event', {}, lead), null);
  assert.equal(boosterMessageFor(undefined, {}, lead), null);
});

// ── The three clocks, in the knowledge-base seed script ──────────────────────
//
// scripts/update-divaost-from-spec.mjs seeds the FAQ rows the bot actually
// answers from. Those rows are ALREADY live in Supabase, so editing the script
// changes nothing on its own — but a wrong number left in the file is how it
// comes back the next time anyone re-runs it.
//
// Only ONE of the three clocks moved. Each answer now names the event it
// counts from, because "14" and "30" alone are what let a 30-day post-
// signature window get pasted over a 14-day pre-signature one.
test('the KB seed script keeps the three clocks distinct, each anchored to the event it counts from', () => {
  const src = fs.readFileSync(new URL('../scripts/update-divaost-from-spec.mjs', import.meta.url), 'utf8');

  // Clock 2 — post-signature quote validity. The one that moved to 30, and the
  // only one the owner's "30 יום מרגע שנחתמה" was ever about.
  assert.match(src, /ההצעה בתוקף 30 יום מרגע החתימה/,
    'the 30-day quote window must name the SIGNATURE as its anchor, not a vague "אישור"');
  assert.doesNotMatch(src, /ההצעה בתוקף 30 יום מרגע האישור/,
    '"מרגע האישור" is the ambiguity that caused this — it reads as either clock');

  // Clock 1 — pre-signature link validity. Stays 14 on express, and now says
  // out loud that it is the LINK being measured.
  assert.match(src, /הקישור להצעה בתוקף 14 יום מרגע קבלתו/,
    'the link window stays 14 and must name the link, so it cannot be read as the quote window');

  // Clock 3 — contractual payment deadline. Confirmed unchanged at 14.
  assert.match(src, /בתוקף 14 יום לתשלום/,
    'the contractual payment deadline stays 14 — never blanket-replace it');
});

test('toWaNumber expands a leading Israeli 0 to the international prefix', () => {
  assert.equal(toWaNumber('0521234567'), '972521234567');
});

test('toWaNumber strips punctuation before converting', () => {
  assert.equal(toWaNumber('052-123-4567'), '972521234567');
});

test('toWaNumber leaves an already-international number alone', () => {
  assert.equal(toWaNumber('972521234567'), '972521234567');
});

test('toWaNumber returns a short/empty string unchanged rather than throwing on bad input', () => {
  assert.equal(toWaNumber(''), '');
  assert.equal(toWaNumber(null), '');
});
