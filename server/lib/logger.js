import { supabase as realSupabase } from './supabase.js';
import { sumUsage } from './model-usage.js';

let supabase = realSupabase; // test seam — same convention as lib/context.js
export function _setSupabaseForTest(fake) { supabase = fake ?? realSupabase; }

// Call at the start of each inbound message. Returns a run object you pass to stepStart/complete.
export async function startRun({ session_id, business_id, inbound_message }) {
  const { data, error } = await supabase
    .from('agent_runs')
    .insert({ session_id, business_id: business_id || null, inbound_message, status: 'running' })
    .select('id, created_at')
    .single();

  if (error) {
    // Logging must never crash the agent — degrade silently.
    console.error('[logger] startRun failed:', error.message);
    return createNullRun();
  }

  return { id: data.id, startedAt: Date.now(), steps: [] };
}

// Call immediately before executing a step. Returns a step handle for stepDone.
export function stepStart(run, stepName, input = {}) {
  return { run, stepName, ts: Date.now(), input };
}

// Call after a step completes. Appends the result to the run's steps array in DB.
export async function stepDone(handle, output = {}, error = null) {
  const { run, stepName, ts, input } = handle;
  if (run._null) return;

  const step = {
    step: stepName,
    status: error ? 'error' : 'success',
    duration_ms: Date.now() - ts,
    input: redact(input),
    output: redact(output),
    error: error ?? null,
    ts: new Date(ts).toISOString(),
  };

  run.steps.push(step);

  await supabase.rpc('append_agent_run_step', { run_id: run.id, step });
}

// Cost-efficiency pass (2026-08-12): appends one `model_usage` step per
// Anthropic call the turn made, plus one `usage_total` step summing them —
// straight into the SAME steps jsonb array stepDone already writes to (no
// schema change). Mirrors stepDone's shape ({step, status, duration_ms,
// input, output, error, ts}) so Studio's existing step viewer needs no
// special-casing later; duration_ms is 0 because these are recorded after
// the fact from data the call already returned, not timed themselves.
export async function logUsage(run, entries) {
  if (run?._null || !entries?.length) return;
  const ts = new Date().toISOString();
  const steps = entries.map((entry) => ({
    step: 'model_usage', status: 'success', duration_ms: 0,
    input: { model: entry.model }, output: redact(entry), error: null, ts,
  }));
  steps.push({
    step: 'usage_total', status: 'success', duration_ms: 0,
    input: { calls: entries.length }, output: redact(sumUsage(entries)), error: null, ts,
  });
  for (const step of steps) {
    run.steps.push(step);
    try {
      await supabase.rpc('append_agent_run_step', { run_id: run.id, step });
    } catch (e) {
      console.error('[logger] logUsage step append failed:', e.message);
    }
  }
}

// Call at the end of the pipeline with the final response text.
export async function completeRun(run, { final_response, session_mode, error = null } = {}) {
  if (run._null) return;

  const total_duration_ms = Date.now() - run.startedAt;

  const update = {
    status: error ? 'error' : 'success',
    steps: run.steps,
    final_response: final_response ?? null,
    session_mode: session_mode ?? null,
    error: error ?? null,
    total_duration_ms,
    completed_at: new Date().toISOString(),
  };
  // index.js stamps these on the run object once normalize/load_context resolve them
  if (run.session_id) update.session_id = run.session_id;
  if (run.business_id) update.business_id = run.business_id;

  await supabase.from('agent_runs').update(update).eq('id', run.id);
}

// ─── helpers ────────────────────────────────────────────────────────────────

function createNullRun() {
  return { _null: true, id: null, startedAt: Date.now(), steps: [] };
}

const REDACTED = '[redacted]';
const SENSITIVE_KEYS = new Set(['api_key', 'apikey', 'authorization', 'password', 'token', 'secret']);

function redact(obj, depth = 0) {
  if (depth > 5 || obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(v => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [
      k,
      SENSITIVE_KEYS.has(k.toLowerCase()) ? REDACTED : redact(v, depth + 1),
    ])
  );
}
