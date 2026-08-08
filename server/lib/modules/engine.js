// Module engine: loads a business's enabled modules, builds their prompt
// context, and executes model-requested actions server-side. Everything in
// here fails SOFT — a broken module must never break the reply pipeline.
import { MODULES } from './registry.js';

let db = null; // test seam
export function _setDbForTest(fake) { db = fake; }

async function realDb() {
  const { supabase } = await import('../supabase.js');
  return {
    async loadEnabled(businessId) {
      const { data, error } = await supabase.from('business_modules')
        .select('*').eq('business_id', businessId).eq('enabled', true);
      if (error) throw error;
      return data ?? [];
    },
    async insertEvent(row) {
      await supabase.from('module_events').insert(row);
    },
  };
}

export async function getEnabledModules(businessId) {
  if (db) return db.enabledRows.filter(r => r.business_id === businessId && r.enabled);
  return (await realDb()).loadEnabled(businessId);
}

export function logModuleEvent(businessId, moduleKey, eventType, detail) {
  const row = { business_id: businessId, module_key: moduleKey, event_type: eventType, detail: detail ?? null };
  if (db) { db.onEvent?.(row); return; }
  realDb().then(d => d.insertEvent(row)).catch(e => console.error('[module_events]', e.message));
}

// Spec §3: a token failure flips the module row to status 'error' so the
// admin sees red and the agent stops offering the capability.
export function markModuleError(businessId, moduleKey, detail) {
  if (db) { db.onMarkError?.({ businessId, moduleKey, detail }); return; }
  import('../supabase.js').then(({ supabase }) =>
    supabase.from('business_modules')
      .update({ status: 'error', status_detail: String(detail).slice(0, 300), updated_at: new Date().toISOString() })
      .eq('business_id', businessId).eq('module_key', moduleKey)
  ).catch(e => console.error('[modules] markError failed:', e.message));
}

// sessionCtx ({ session_id }) lets a module tailor its context block to WHO
// is talking — e.g. the booster module reads the lead's funnel status from
// the sender's phone. Optional third argument: providers that don't care
// simply ignore it.
export async function buildModulesContext(business, sessionCtx) {
  let rows;
  try { rows = await getEnabledModules(business.id); } catch (e) {
    console.error('[modules] load failed:', e.message); return null;
  }
  const blocks = [];
  for (const row of rows) {
    const def = MODULES[row.module_key];
    if (!def) continue;
    try {
      const block = await def.contextProvider(business, row, sessionCtx);
      if (block) blocks.push(block);
    } catch (e) {
      logModuleEvent(business.id, row.module_key, 'context_error', { error: e.message });
      if (e.code === 'TOKEN_ERROR') markModuleError(business.id, row.module_key, e.message);
    }
  }
  return blocks.length ? blocks.join('\n\n') : null;
}

// A handler may return, alongside its text, a STRUCTURED `result` describing
// what actually happened (e.g. calendar.book's {ok, tentative}). The decision
// layer gates on that rather than on the reply copy, so a module is free to
// reword itself without silently changing pipeline behaviour. `result` is null
// whenever the action did not run or made no claim — never a guess.
//
// A handler may also set `replaceResponse: true` to say its text IS the whole
// reply — for pinned copy that a model answer would contradict rather than
// introduce. The default stays "append to the model's text".
const noOutcome = () => ({ text: null, result: null, replaceResponse: false });

export async function executeModuleAction(business, action, sessionCtx) {
  if (!action) return noOutcome();
  const { module: moduleKey, name, payload } = action;
  const def = MODULES[moduleKey];
  const actionDef = def?.actions?.[name];
  try {
    const rows = await getEnabledModules(business.id);
    const row = rows.find(r => r.module_key === moduleKey);
    if (!def || !actionDef || !row) return noOutcome();

    const parsed = actionDef.schema.safeParse(payload);
    if (!parsed.success) {
      logModuleEvent(business.id, moduleKey, `action.${name}_failed`, { reason: 'invalid_payload', issues: parsed.error.issues });
      return noOutcome();
    }
    const out = await actionDef.handler(business, row, parsed.data, sessionCtx);
    logModuleEvent(business.id, moduleKey, `action.${name}`, { payload: parsed.data, ok: !out?.failureText });
    return {
      text: out?.confirmationText ?? out?.failureText ?? null,
      result: out?.result ?? null,
      replaceResponse: out?.replaceResponse === true,
    };
  } catch (e) {
    logModuleEvent(business.id, moduleKey, `action.${name}_failed`, { reason: 'handler_error', error: e.message });
    if (e.code === 'TOKEN_ERROR') markModuleError(business.id, moduleKey, e.message);
    return noOutcome();
  }
}
