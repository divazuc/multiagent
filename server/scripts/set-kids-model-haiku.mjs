// One-off (2026-08-12): the owner's Haiku quality trial for the kids
// business. agents/conversation.js#resolveModel reads
// business_profiles.persona.conversation_model and, if it's on the
// allow-list, uses it for every call that business's turns make (intent
// detection, reply generation, rewrite) instead of the default Sonnet 4.6 —
// no schema change, persona is already jsonb.
//
// Idempotent: merges into the existing persona jsonb; re-running just writes
// the same value again. Refuses to run against a business with no
// business_profiles row.
//
//   node --env-file=.env.local scripts/set-kids-model-haiku.mjs
import { supabase } from '../lib/supabase.js';

const BUSINESS_ID = 'f53bdccc-e62d-45f8-8c08-eee5594ce221'; // קרוספיט קידס
const CONVERSATION_MODEL = 'claude-haiku-4-5-20251001';

const { data: row, error: readErr } = await supabase.from('business_profiles')
  .select('business_id, persona')
  .eq('business_id', BUSINESS_ID).maybeSingle();

if (readErr) {
  console.error('[set-kids-model-haiku] read failed:', readErr.message);
  process.exit(1);
}
if (!row) {
  console.error('[set-kids-model-haiku] no business_profiles row for', BUSINESS_ID);
  process.exit(1);
}

const persona = { ...(row.persona ?? {}), conversation_model: CONVERSATION_MODEL };
const { error } = await supabase.from('business_profiles')
  .update({ persona, updated_at: new Date().toISOString() })
  .eq('business_id', BUSINESS_ID);

if (error) {
  console.error('[set-kids-model-haiku] update failed:', error.message);
  process.exit(1);
}

const { data: verify } = await supabase.from('business_profiles')
  .select('persona').eq('business_id', BUSINESS_ID).maybeSingle();
console.log('[set-kids-model-haiku] persona.conversation_model is now:',
  verify?.persona?.conversation_model);
