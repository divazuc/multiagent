import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone } from '../lib/relay/phone.js';

test('strips punctuation and expands a leading Israeli 0', () => {
  assert.equal(normalizePhone('054-8139333'), '972548139333');
});

test('leaves an already-normalised number alone', () => {
  assert.equal(normalizePhone('972559489893'), '972559489893');
});

test('accepts + and spaces', () => {
  assert.equal(normalizePhone('+972 55 948 9893'), '972559489893');
});

test('rejects anything too short or too long to be a phone', () => {
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('9725594898931234567'), null);
});

test('rejects empty and non-string input', () => {
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone(null), null);
});
