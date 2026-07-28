// Open questions waiting on a human. Short codes are for humans to type, so
// they recycle within a business rather than being globally unique; collisions
// are impossible because only 'open' rows are ever matched.
let db = null; // test seam
export function _setDbForTest(fake) { db = fake; }

async function realDb() {
  const { supabase } = await import('../supabase.js');
  return {
    async insert(row) {
      const { data, error } = await supabase.from('escalations').insert(row).select().maybeSingle();
      if (error) throw error;
      return data;
    },
    async listOpen(businessId) {
      const { data, error } = await supabase.from('escalations')
        .select('*').eq('business_id', businessId).eq('status', 'open')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
    async update(id, patch) {
      const { error } = await supabase.from('escalations').update(patch).eq('id', id);
      if (error) throw error;
    },
    async listAllOpen() {
      const { data, error } = await supabase.from('escalations')
        .select('*').eq('status', 'open').order('created_at', { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  };
}

const getDb = async () => db ?? await realDb();

const MAX_CODE = 99;

// Pure, so a caller that already holds the open rows (raiseEscalation reads
// them for the per-session dedupe) does not pay for a second query.
export function pickShortCode(openRows = []) {
  const used = new Set(openRows.map(r => r.short_code));
  for (let c = 1; c <= MAX_CODE; c++) if (!used.has(c)) return c;
  return 1; // every code in use — reuse the lowest; practically unreachable
}

export async function nextShortCode(businessId) {
  return pickShortCode(await (await getDb()).listOpen(businessId));
}

export async function createEscalation(fields) { return (await getDb()).insert(fields); }
export async function listOpen(businessId)     { return (await getDb()).listOpen(businessId); }
export async function listAllOpen()            { return (await getDb()).listAllOpen(); }

// Patched in AFTER the rep send succeeds. The row is inserted first so the
// short code is reserved by the partial unique index before any human is shown
// it — see raiseEscalation.
export async function setRepMessageId(id, repMessageId) {
  await (await getDb()).update(id, { rep_message_id: repMessageId });
}

export async function markAnswered(id, answer) {
  await (await getDb()).update(id, { status: 'answered', answer, answered_at: new Date().toISOString() });
}
export async function markStopped(id) { await (await getDb()).update(id, { status: 'stopped' }); }
export async function markExpired(id) { await (await getDb()).update(id, { status: 'expired' }); }

export async function recordNudge(id) {
  const s = await getDb();
  const rows = await s.listAllOpen();
  const current = rows.find(r => r.id === id)?.nudge_count;
  const base = typeof current === 'number' ? current : 0;
  await s.update(id, { nudge_count: base + 1, last_nudge_at: new Date().toISOString() });
}
