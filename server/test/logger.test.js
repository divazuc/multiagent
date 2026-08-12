import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://supabase.invalid';
process.env.SUPABASE_SERVICE_KEY = 'stub-service-key';

const { logUsage, _setSupabaseForTest } = await import('../lib/logger.js');
const { extractUsage } = await import('../lib/model-usage.js');

function fakeSupabaseRpc() {
  const calls = [];
  return {
    calls,
    rpc: async (name, args) => { calls.push({ name, args }); return { data: null, error: null }; },
  };
}

test.afterEach(() => _setSupabaseForTest(null));

test('logUsage appends one model_usage step per call plus one usage_total step', async () => {
  const fake = fakeSupabaseRpc();
  _setSupabaseForTest(fake);

  const run = { id: 'run-1', steps: [] };
  const entries = [
    extractUsage({ input_tokens: 100, output_tokens: 20 }, 'claude-sonnet-4-6'),
    extractUsage({ input_tokens: 50, output_tokens: 10 }, 'claude-sonnet-4-6'),
  ];

  await logUsage(run, entries);

  assert.equal(run.steps.length, 3, 'two model_usage + one usage_total');
  assert.equal(run.steps[0].step, 'model_usage');
  assert.equal(run.steps[0].output.model, 'claude-sonnet-4-6');
  assert.equal(run.steps[0].output.input_tokens, 100);
  assert.equal(run.steps[1].step, 'model_usage');
  assert.equal(run.steps[1].output.input_tokens, 50);
  assert.equal(run.steps[2].step, 'usage_total');
  assert.equal(run.steps[2].output.calls, 2);
  assert.equal(run.steps[2].output.input_tokens, 150);

  // Every step is persisted via the existing atomic RPC — no schema change.
  assert.equal(fake.calls.length, 3);
  assert.ok(fake.calls.every(c => c.name === 'append_agent_run_step' && c.args.run_id === 'run-1'));
});

test('logUsage is a no-op on an empty or missing usage list', async () => {
  const fake = fakeSupabaseRpc();
  _setSupabaseForTest(fake);
  const run = { id: 'run-2', steps: [] };

  await logUsage(run, []);
  await logUsage(run, undefined);

  assert.equal(run.steps.length, 0);
  assert.equal(fake.calls.length, 0);
});

test('logUsage is a no-op on a null run (startRun failed upstream) — never throws', async () => {
  const fake = fakeSupabaseRpc();
  _setSupabaseForTest(fake);
  const nullRun = { _null: true, id: null, steps: [] };

  await assert.doesNotReject(() =>
    logUsage(nullRun, [extractUsage({ input_tokens: 10 }, 'claude-sonnet-4-6')]));
  assert.equal(fake.calls.length, 0);
});

test('logUsage survives an RPC failure — the step still lands in run.steps for completeRun to persist', async () => {
  _setSupabaseForTest({ rpc: async () => { throw new Error('db unreachable'); } });
  const run = { id: 'run-3', steps: [] };

  await assert.doesNotReject(() =>
    logUsage(run, [extractUsage({ input_tokens: 10 }, 'claude-sonnet-4-6')]));
  assert.equal(run.steps.length, 2, 'model_usage + usage_total still appended in-memory');
});
