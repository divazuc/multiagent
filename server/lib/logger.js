import { supabase } from './supabase.js';

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

// Call at the end of the pipeline with the final response text.
export async function completeRun(run, { final_response, session_mode, error = null } = {}) {
  if (run._null) return;

  const total_duration_ms = Date.now() - run.startedAt;

  await supabase
    .from('agent_runs')
    .update({
      status: error ? 'error' : 'success',
      steps: run.steps,
      final_response: final_response ?? null,
      session_mode: session_mode ?? null,
      error: error ?? null,
      total_duration_ms,
      completed_at: new Date().toISOString(),
    })
    .eq('id', run.id);
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
