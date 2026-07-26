// Short, dictatable connect codes.
//
// The long signed state still does the actual authorising — this table is only
// a lookup handle, so the security model is unchanged. It exists because a
// 147-character state string is unusable in practice: it wraps in terminals and
// chat clients, and a single shifted character fails the HMAC. The client who
// receives a connect link must be able to copy it, type it, or read it aloud.
import crypto from 'node:crypto';

// No 0/O and no 1/I/L — this gets read over the phone.
export const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LEN = 6;

let db = null; // test seam
export function _setDbForTest(fake) { db = fake; }

async function realDb() {
  const { supabase } = await import('../supabase.js');
  return {
    async insert(row) {
      const { error } = await supabase.from('connect_links').insert(row);
      if (error) throw error;
    },
    async findByCode(code) {
      const { data, error } = await supabase.from('connect_links')
        .select('*').eq('code', code).maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
    async markUsed(code) {
      await supabase.from('connect_links')
        .update({ used_at: new Date().toISOString() }).eq('code', code);
    },
  };
}

const getDb = async () => db ?? await realDb();

export function encodeCode(bytes) {
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export function newCode() {
  // Rejection sampling: 256 is not a multiple of 31, so raw modulo would make
  // the first few letters slightly more likely than the rest.
  const max = 256 - (256 % ALPHABET.length);
  const bytes = [];
  while (bytes.length < CODE_LEN) {
    for (const b of crypto.randomBytes(CODE_LEN)) {
      if (b < max && bytes.length < CODE_LEN) bytes.push(b);
    }
  }
  return encodeCode(Uint8Array.from(bytes));
}

export async function createConnectCode({ businessId, moduleKey, state, ttlMs }) {
  const code = newCode();
  await (await getDb()).insert({
    code,
    business_id: businessId,
    module_key: moduleKey,
    state,
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
  });
  return code;
}

// Returns the row (with .state) or null. Expiry is enforced here as well as by
// the signed state itself, so a stale row can never authorise anything.
export async function resolveConnectCode(code) {
  const norm = String(code ?? '').trim().toUpperCase();
  if (!norm) return null;
  const store = await getDb();
  const row = await store.findByCode(norm);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  // Recorded for audit only — the consent page may legitimately be reloaded.
  if (!row.used_at) await store.markUsed(norm);
  return row;
}
