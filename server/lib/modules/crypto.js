// Module secrets encryption at rest (spec C-04/F-04): AES-256-GCM.
// business_modules.secrets never holds plaintext.
import crypto from 'node:crypto';

function key() {
  const b64 = process.env.MODULE_SECRETS_KEY;
  if (!b64) throw new Error('MODULE_SECRETS_KEY not set');
  const k = Buffer.from(b64, 'base64');
  if (k.length !== 32) throw new Error('MODULE_SECRETS_KEY must be 32 bytes base64');
  return k;
}

export function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function decryptSecret(box) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8');
}

export function encryptSecrets(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) out[k] = typeof v === 'string' ? encryptSecret(v) : v;
  return out;
}

export function decryptSecrets(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) out[k] = v && typeof v === 'object' && v.iv ? decryptSecret(v) : v;
  return out;
}
