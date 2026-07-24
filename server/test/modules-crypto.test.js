import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.MODULE_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
const { encryptSecret, decryptSecret, encryptSecrets, decryptSecrets } = await import('../lib/modules/crypto.js');

test('round-trip', () => {
  const box = encryptSecret('refresh-token-שלום');
  assert.notEqual(box.data, 'refresh-token-שלום');
  assert.ok(box.iv && box.tag && box.data);
  assert.equal(decryptSecret(box), 'refresh-token-שלום');
});

test('tamper detection', () => {
  const box = encryptSecret('secret');
  const bad = { ...box, data: Buffer.from('xx' + Buffer.from(box.data, 'base64').toString('hex').slice(2), 'hex').toString('base64') };
  assert.throws(() => decryptSecret(bad));
});

test('object helpers round-trip and skip non-strings', () => {
  const enc = encryptSecrets({ refresh_token: 'rt', account_email: 'a@b.c', n: 5 });
  assert.equal(typeof enc.refresh_token, 'object');
  assert.equal(enc.n, 5);
  const dec = decryptSecrets(enc);
  assert.equal(dec.refresh_token, 'rt');
  assert.equal(dec.account_email, 'a@b.c');
});
