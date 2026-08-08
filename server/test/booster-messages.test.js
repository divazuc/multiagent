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
    { link_url: 'https://booster.divdev.co/e/abc123', valid_days: 14 }, lead);
  assert.ok(msg && msg.length > 0);
  assert.match(msg, /https:\/\/booster\.divdev\.co\/e\/abc123/);
  assert.match(msg, /דנה/, 'greets by first name, not the full name');
  assert.doesNotMatch(msg, /דנה כהן/, 'must use the first name only');
});

test('send_personal_link falls back to 14 valid days when the payload omits it', () => {
  const msg = boosterMessageFor('send_personal_link', { link_url: 'https://x/y' }, lead);
  assert.match(msg, /14/);
});

test('send_signed_summary carries the quote number and a formatted total', () => {
  const msg = boosterMessageFor('send_signed_summary', { quote_number: 'Q-1042', total: 500 }, lead);
  assert.ok(msg && msg.length > 0);
  assert.match(msg, /Q-1042/);
  assert.match(msg, /₪500/);
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
test('send_expiry_notice: unsigned_14d reason returns the generic link-expired text', () => {
  const msg = boosterMessageFor('send_expiry_notice', { reason: 'unsigned_14d' }, lead);
  assert.match(msg, /פג תוקף/);
});

test('send_expiry_notice: unsigned_30d reason (questionnaire-track cutoff) also returns the link-expired text', () => {
  const msg = boosterMessageFor('send_expiry_notice', { reason: 'unsigned_30d' }, lead);
  assert.match(msg, /פג תוקף/);
});

test('send_expiry_notice: materials_30d reason acknowledges the closed order + one-year credit and invites renewal', () => {
  const msg = boosterMessageFor('send_expiry_notice', { reason: 'materials_30d' }, lead);
  assert.match(msg, /קרדיט/);
  assert.match(msg, /שנה/);
  assert.doesNotMatch(msg, /פג תוקף/, 'must not reuse the generic expired-link text for a paying client');
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
