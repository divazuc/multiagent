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

// A nudge is a SECOND message in the rep's thread, and by construction the most
// recent one — so it is what a rep naturally quote-replies to. Its id has to be
// matchable or the reply falls through to matchedBy:'recent' and answers
// whichever escalation happens to be newest, i.e. the wrong lead.
//
// Kept as its own append-only column rather than overwriting rep_message_id,
// because a rep who scrolls up and quotes the ORIGINAL escalation message must
// keep matching too. Capped: a row can be nudged at most nudge_max_count times,
// but the cap costs nothing and stops a stuck row from growing an array.
//
// Deliberately separate from recordNudge: the counter must advance even if this
// does not. Pre-DDL (see the report's DDL section) postgres rejects the unknown
// column, so this falls back to repointing rep_message_id at the nudge —
// strictly worse than the array (the original stops matching) and strictly
// better than mis-delivering another lead's answer.
const MAX_REP_MESSAGE_IDS = 8;

export async function attachNudgeMessageId(id, repMessageId) {
  if (!repMessageId) return;
  const s = await getDb();
  try {
    const rows = await s.listAllOpen();
    const current = rows.find(r => r.id === id)?.rep_message_ids;
    const ids = Array.isArray(current) ? current : [];
    if (ids.includes(repMessageId)) return;
    await s.update(id, { rep_message_ids: [...ids, repMessageId].slice(-MAX_REP_MESSAGE_IDS) });
  } catch (e) {
    console.error('[relay] could not append the nudge message id (rep_message_ids column missing?):', e.message);
    try { await s.update(id, { rep_message_id: repMessageId }); }
    catch (e2) { console.error('[relay] nudge message id fallback also failed:', e2.message); }
  }
}
