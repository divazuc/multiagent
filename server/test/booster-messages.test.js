// server/test/booster-messages.test.js
//
// Task 15 (seam 2) — the bot turns a booster outbox event into the Hebrew
// WhatsApp copy the client actually reads. Every known event must produce a
// non-empty message that carries the payload's key fact (the link, the quote
// number, ...); an unknown event must return null so the route can ack and
// skip it rather than retry forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boosterMessageFor, toWaNumber } from '../lib/booster-messages.js';

const lead = { name: 'דנה כהן', phone: '0521234567' };

test('send_personal_link carries the link url and greets the lead by first name', () => {
  const msg = boosterMessageFor('send_personal_link',
    { link_url: 'https://booster.divdev.co/e/abc123', valid_days: 30 }, lead);
  assert.ok(msg && msg.length > 0);
  assert.match(msg, /https:\/\/booster\.divdev\.co\/e\/abc123/);
  assert.match(msg, /30/, 'the payload\'s own window is what the client is told');
  assert.match(msg, /דנה/, 'greets by first name, not the full name');
  assert.doesNotMatch(msg, /דנה כהן/, 'must use the first name only');
});

// Owner decision: every track's window is 30 days (link validity, the
// questionnaire cutoff, the materials window). The fallback is what a payload
// with no valid_days produces, so it must not quietly re-introduce the old 14.
test('send_personal_link falls back to 30 valid days when the payload omits it — all tracks are 30 days', () => {
  const msg = boosterMessageFor('send_personal_link', { link_url: 'https://x/y' }, lead);
  assert.match(msg, /30/);
  assert.doesNotMatch(msg, /14/, 'the old 14-day default is gone, not merely shadowed');
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
test('send_expiry_notice: unsigned_30d reason (the unified 30-day link window) returns the generic link-expired text', () => {
  const msg = boosterMessageFor('send_expiry_notice', { reason: 'unsigned_30d' }, lead);
  assert.match(msg, /פג תוקף/);
});

// The catch-all `else` IS the contract, not a convenience: the list of
// graduated cutoffs belongs to the booster and changes without this repo (the
// legacy unsigned_14d, a future unsigned_60d, a payload with no reason at all).
// Anything that is not materials_30d is a plain expired link and must never
// fall through unhandled.
test('send_expiry_notice: any UNRECOGNIZED reason still returns the generic link-expired text', () => {
  for (const reason of ['unsigned_14d', 'unsigned_60d', 'some_future_cutoff', null, undefined]) {
    const msg = boosterMessageFor('send_expiry_notice', { reason }, lead);
    assert.match(msg, /פג תוקף/, `reason=${reason} must not fall through unhandled`);
  }
});

test('send_expiry_notice: materials_30d reason acknowledges the closed order + one-year credit and invites renewal', () => {
  const msg = boosterMessageFor('send_expiry_notice', { reason: 'materials_30d' }, lead);
  assert.match(msg, /קרדיט/);
  assert.match(msg, /שנה/);
  assert.doesNotMatch(msg, /פג תוקף/, 'must not reuse the generic expired-link text for a paying client');
});

// ── T8 (funnel track 1): the materials-stage templates ───────────────────────
// Payload shapes verified against the booster repo: send_materials_checklist
// will carry { quote_number, folder_url, materials_doc_url, content_doc_url }
// (meeting-before-payment plan Task 9); ack_materials / notify_live carry
// nothing; send_start_date carries { start_date: 'YYYY-MM-DD' }.

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
