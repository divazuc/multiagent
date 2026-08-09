// normalizeMessage is the pipeline's front door and had no tests of its own.
// It grew a third field — profile_name — so that a module handler can name a
// lead without the bot interrogating the customer for it in chat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessage } from '../lib/normalize.js';

const cloud = (overrides = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{
    changes: [{
      value: {
        metadata: { phone_number_id: '111222333' },
        contacts: [{ wa_id: '972501234567', profile: { name: 'דנה כהן' } }],
        messages: [{ from: '972501234567', type: 'text', text: { body: 'היי!' } }],
        ...overrides,
      },
    }],
  }],
});

test('a Cloud API message normalizes to message + session_id + phone_number_id', () => {
  const r = normalizeMessage(cloud());
  assert.equal(r.status, 'success');
  assert.equal(r.result.message, 'היי!');
  assert.equal(r.result.session_id, '972501234567');
  assert.equal(r.result.phone_number_id, '111222333');
});

test('the WhatsApp profile name is carried through as profile_name', () => {
  assert.equal(normalizeMessage(cloud()).result.profile_name, 'דנה כהן');
});

test('profile_name is null — never undefined or "" — when WhatsApp sends no profile', () => {
  for (const contacts of [[{ wa_id: '972501234567' }], [{ wa_id: '972501234567', profile: {} }],
    [{ wa_id: '972501234567', profile: { name: '   ' } }], []]) {
    const r = normalizeMessage(cloud({ contacts }));
    assert.equal(r.result.profile_name, null, `contacts ${JSON.stringify(contacts)}`);
  }
});

test('a profile name is trimmed and length-capped — it is customer-controlled text', () => {
  const long = 'א'.repeat(400);
  const r = normalizeMessage(cloud({ contacts: [{ wa_id: '972501234567', profile: { name: `  ${long}  ` } }] }));
  assert.ok(r.result.profile_name.length <= 80, 'a display name is not a free-text field for the booster');
  assert.ok(!r.result.profile_name.startsWith(' '));
});

test('the direct {message, session_id} shape (Studio) carries no profile name', () => {
  const r = normalizeMessage({ message: 'שלום', session_id: 'studio-1' });
  assert.equal(r.status, 'success');
  assert.equal(r.result.session_id, 'studio-1');
  assert.equal(r.result.profile_name, null);
});

test('an empty message or session_id is still rejected', () => {
  assert.equal(normalizeMessage({ message: '   ', session_id: 'x' }).status, 'error');
  assert.equal(normalizeMessage({ message: 'hi', session_id: '  ' }).status, 'error');
  assert.equal(normalizeMessage({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: {} }] }] }).status, 'error');
});
