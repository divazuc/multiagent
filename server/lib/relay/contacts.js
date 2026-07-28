// The two humans behind a business: the owner (the client) and the rep who
// answers escalations. One row per role — see the design spec §1.2 for why
// this is a table rather than more columns.
import { normalizePhone } from './phone.js';

let db = null; // test seam
export function _setDbForTest(fake) { db = fake; }

async function realDb() {
  const { supabase } = await import('../supabase.js');
  return {
    async listContacts(businessId) {
      const { data, error } = await supabase.from('business_contacts')
        .select('*').eq('business_id', businessId);
      if (error) throw error;
      return data ?? [];
    },
    async upsertContact(row) {
      const { error } = await supabase.from('business_contacts')
        .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'business_id,role' });
      if (error) throw error;
    },
  };
}

const getDb = async () => db ?? await realDb();

export async function getContacts(businessId) {
  return (await getDb()).listContacts(businessId);
}

export async function resolveRep(businessId) {
  const rows = await getContacts(businessId);
  const withPhone = r => r && r.phone;
  return rows.find(r => r.role === 'rep' && withPhone(r))
      ?? rows.find(r => r.role === 'owner' && withPhone(r))
      ?? null;
}

export async function findContactByPhone(businessId, phone) {
  const norm = normalizePhone(phone);
  if (!norm) return null;
  const rows = await getContacts(businessId);
  return rows.find(r => r.phone === norm) ?? null;
}

export async function upsertContact(businessId, role, fields) {
  const row = { business_id: businessId, role, ...fields };
  if (fields.phone != null && fields.phone !== '') {
    const norm = normalizePhone(fields.phone);
    if (!norm) throw new Error(`unusable phone: ${fields.phone}`);
    row.phone = norm;
  }
  await (await getDb()).upsertContact(row);
}
