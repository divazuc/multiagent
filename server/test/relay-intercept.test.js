// server/test/relay-intercept.test.js
//
// The gate in /wa-inbound that keeps a rep's message out of the conversation
// agent. The feature's whole premise is that a rep must never be treated as a
// lead — so when this gate cannot answer the question "is the sender a listed
// contact?", the only safe answer is to stop, not to sell.
//
// It lived inline in index.js and was therefore untestable: on a lookup error
// it logged, left `biz` null, skipped the relay block and ran the pipeline —
// i.e. a transient DB hiccup made the bot pitch its own client.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as intercept from '../lib/relay/intercept.js';

const MSG = { phoneNumberId: 'PNID', from: '972500000001', text: 'כן, אפשר לפרוס', contextId: 'wamid.X' };

function seed({ biz = { id: 'b1', name: 'קליניקה' }, bizError = null, personaError = null } = {}) {
  intercept._setDbForTest({
    async getBusinessByPhoneNumberId() { if (bizError) throw bizError; return biz; },
    async getPersona() { if (personaError) throw personaError; return { bot_gender: 'female' }; },
  });
}

test('a recognised contact is consumed and the pipeline never runs', async () => {
  seed();
  const calls = [];
  intercept._setHandlerForTest(async (args) => { calls.push(args); return true; });

  assert.equal(await intercept.interceptContactMessage(MSG), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].business, { id: 'b1', name: 'קליניקה' });
  assert.equal(calls[0].from, '972500000001');
  assert.equal(calls[0].text, 'כן, אפשר לפרוס');
  assert.equal(calls[0].contextId, 'wamid.X');
  assert.deepEqual(calls[0].persona, { bot_gender: 'female' });
});

test('a clean "not a contact" lets the message through to the pipeline', async () => {
  seed();
  intercept._setHandlerForTest(async () => false);
  assert.equal(await intercept.interceptContactMessage(MSG), false);
});

test('a business LOOKUP ERROR skips the pipeline instead of falling through', async () => {
  seed({ bizError: new Error('transient db error') });
  intercept._setHandlerForTest(async () => { throw new Error('must not be reached'); });

  assert.equal(await intercept.interceptContactMessage(MSG), true,
    'not knowing whether the sender is a rep must never resolve to "sell to them"');
});

test('a handler that throws skips the pipeline instead of falling through', async () => {
  seed();
  intercept._setHandlerForTest(async () => { throw new Error('transient db error'); });

  assert.equal(await intercept.interceptContactMessage(MSG), true);
});

test('a persona lookup failure still lets the relay run — it is cosmetic, not identity', async () => {
  seed({ personaError: new Error('transient db error') });
  const calls = [];
  intercept._setHandlerForTest(async (args) => { calls.push(args); return true; });

  assert.equal(await intercept.interceptContactMessage(MSG), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].persona, null, 'a missing persona only costs the default gender');
});

test('no business owns the receiving number — nothing to scope a contact lookup to', async () => {
  seed({ biz: null });
  intercept._setHandlerForTest(async () => { throw new Error('must not be reached'); });
  assert.equal(await intercept.interceptContactMessage(MSG), false);
});
