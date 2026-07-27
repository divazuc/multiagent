// Set (or reset) the password of a client portal account.
//
//   node --env-file=.env.local scripts/set-portal-password.js <business_id> <email> <password>
//
// Run this yourself so the password never travels through a chat log or an
// issue tracker. It upserts on email, so re-running it is a reset.
import { supabase } from '../lib/supabase.js';
import { hashPassword } from '../lib/portal.js';

const [businessId, email, password] = process.argv.slice(2);

if (!businessId || !email || !password) {
  console.error('usage: set-portal-password.js <business_id> <email> <password>');
  process.exit(1);
}
if (password.length < 8) {
  console.error('refusing: use at least 8 characters');
  process.exit(1);
}

const { data: biz } = await supabase.from('businesses').select('id, name').eq('id', businessId).maybeSingle();
if (!biz) { console.error('no such business:', businessId); process.exit(1); }

const { error } = await supabase.from('portal_accounts').upsert({
  business_id: businessId,
  email: email.trim().toLowerCase(),
  password_hash: hashPassword(password),
}, { onConflict: 'email' });

if (error) { console.error('failed:', error.message); process.exit(1); }

console.log(`portal account ready: ${email.trim().toLowerCase()} -> ${biz.name}`);
console.log('login at /portal — the password is not printed here on purpose.');
