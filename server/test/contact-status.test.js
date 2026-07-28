import test from 'node:test';
import assert from 'node:assert/strict';
import { STATUS_ORDER, nextStatus } from '../lib/contact-status.js';

test('the ladder advances', () => {
  assert.equal(nextStatus('new_lead', 'in_conversation'), 'in_conversation');
  assert.equal(nextStatus('in_conversation', 'cta_triggered'), 'cta_triggered');
});

test('the ladder never goes backwards', () => {
  assert.equal(nextStatus('cta_triggered', 'in_conversation'), null);
  assert.equal(nextStatus('converted', 'new_lead'), null);
});

test('the same status is not rewritten', () => {
  assert.equal(nextStatus('in_conversation', 'in_conversation'), null);
});

test('a status the client set by hand is never erased', () => {
  // The bug: indexOf returns -1 for an off-ladder value, so every automatic
  // status compared greater and overwrote it. Production had 9 of 14 contacts
  // in this state, including three the client had marked "closed" with the
  // סמן כטופל button — erased the moment the lead wrote again.
  assert.equal(nextStatus('closed', 'in_conversation'), null);
  assert.equal(nextStatus('qualified', 'in_conversation'), null);
  assert.equal(nextStatus('qualified', 'cta_triggered'), null);
});

test('the legacy alias "new" still behaves like new_lead', () => {
  // 'new' is plainly the same thing as 'new_lead', so it should keep advancing
  // rather than freezing like a deliberate manual mark.
  assert.equal(nextStatus('new', 'in_conversation'), 'in_conversation');
  assert.equal(nextStatus('new', 'new_lead'), null);
});

test('a contact with no status yet takes the incoming one', () => {
  assert.equal(nextStatus(null, 'in_conversation'), 'in_conversation');
  assert.equal(nextStatus(undefined, 'new_lead'), 'new_lead');
  assert.equal(nextStatus('', 'in_conversation'), 'in_conversation');
});

test('an unknown incoming status is refused rather than written blind', () => {
  assert.equal(nextStatus('in_conversation', 'banana'), null);
});

test('no incoming status means no change', () => {
  assert.equal(nextStatus('in_conversation', null), null);
});

test('the terminal statuses sit above converted and stay sticky', () => {
  assert.ok(STATUS_ORDER.indexOf('cold') > STATUS_ORDER.indexOf('converted'));
  assert.equal(nextStatus('cold', 'in_conversation'), null);
  assert.equal(nextStatus('converted', 'cold'), 'cold');
});
