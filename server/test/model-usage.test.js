import test from 'node:test';
import assert from 'node:assert/strict';
import { PRICE_PER_MTOK, priceUsage, extractUsage, sumUsage } from '../lib/model-usage.js';

test('the price map carries exactly the two allowed conversation models', () => {
  assert.deepEqual(Object.keys(PRICE_PER_MTOK).sort(), [
    'claude-haiku-4-5-20251001', 'claude-sonnet-4-6',
  ]);
  assert.deepEqual(PRICE_PER_MTOK['claude-sonnet-4-6'], { input: 3.00, output: 15.00 });
  assert.deepEqual(PRICE_PER_MTOK['claude-haiku-4-5-20251001'], { input: 1.00, output: 5.00 });
});

test('priceUsage: plain input/output tokens at list price', () => {
  const cost = priceUsage({ model: 'claude-sonnet-4-6', input_tokens: 1_000_000, output_tokens: 0 });
  assert.equal(cost, 3.00);
  const cost2 = priceUsage({ model: 'claude-sonnet-4-6', input_tokens: 0, output_tokens: 1_000_000 });
  assert.equal(cost2, 15.00);
});

test('priceUsage: cache write is 1.25x input price, cache read is 0.1x', () => {
  const write = priceUsage({ model: 'claude-sonnet-4-6', cache_creation_input_tokens: 1_000_000 });
  assert.equal(write, 3.75);
  const read = priceUsage({ model: 'claude-sonnet-4-6', cache_read_input_tokens: 1_000_000 });
  assert.equal(read, 0.30);
});

test('priceUsage: haiku prices independently from sonnet', () => {
  const cost = priceUsage({ model: 'claude-haiku-4-5-20251001', input_tokens: 1_000_000, output_tokens: 1_000_000 });
  assert.equal(cost, 6.00); // 1.00 + 5.00
});

test('priceUsage: unknown model returns null, not a thrown error or 0', () => {
  assert.equal(priceUsage({ model: 'claude-opus-4-8', input_tokens: 1000 }), null);
});

test('extractUsage: normalizes an Anthropic usage object and prices it', () => {
  const rec = extractUsage(
    { input_tokens: 500, output_tokens: 120, cache_creation_input_tokens: 200, cache_read_input_tokens: 800 },
    'claude-sonnet-4-6',
  );
  assert.equal(rec.model, 'claude-sonnet-4-6');
  assert.equal(rec.input_tokens, 500);
  assert.equal(rec.output_tokens, 120);
  assert.equal(rec.cache_creation_input_tokens, 200);
  assert.equal(rec.cache_read_input_tokens, 800);
  assert.ok(typeof rec.cost_usd === 'number' && rec.cost_usd > 0);
});

test('extractUsage: missing usage fields default to 0, never throw', () => {
  const rec = extractUsage({}, 'claude-sonnet-4-6');
  assert.equal(rec.input_tokens, 0);
  assert.equal(rec.output_tokens, 0);
  assert.equal(rec.cache_creation_input_tokens, 0);
  assert.equal(rec.cache_read_input_tokens, 0);
  const recNull = extractUsage(undefined, 'claude-sonnet-4-6');
  assert.equal(recNull.input_tokens, 0);
});

test('extractUsage: unpriced model still returns a full record, cost_usd null', () => {
  const rec = extractUsage({ input_tokens: 10 }, 'some-future-model');
  assert.equal(rec.cost_usd, null);
  assert.equal(rec.model, 'some-future-model');
});

test('sumUsage: aggregates calls, tokens and cost across a run', () => {
  const entries = [
    extractUsage({ input_tokens: 1000, output_tokens: 200 }, 'claude-sonnet-4-6'),
    extractUsage({ input_tokens: 500, output_tokens: 100 }, 'claude-sonnet-4-6'),
  ];
  const total = sumUsage(entries);
  assert.equal(total.calls, 2);
  assert.equal(total.input_tokens, 1500);
  assert.equal(total.output_tokens, 300);
  assert.equal(total.priced_calls, 2);
  assert.equal(total.unpriced_calls, 0);
  assert.ok(total.cost_usd > 0);
});

test('sumUsage: unpriced calls are counted separately, not silently zero-cost', () => {
  const entries = [
    extractUsage({ input_tokens: 100 }, 'claude-sonnet-4-6'),
    extractUsage({ input_tokens: 100 }, 'unknown-model'),
  ];
  const total = sumUsage(entries);
  assert.equal(total.calls, 2);
  assert.equal(total.priced_calls, 1);
  assert.equal(total.unpriced_calls, 1);
});

test('sumUsage: empty input never throws', () => {
  assert.deepEqual(sumUsage([]), {
    calls: 0, input_tokens: 0, output_tokens: 0,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    cost_usd: 0, priced_calls: 0, unpriced_calls: 0,
  });
  assert.deepEqual(sumUsage(undefined), sumUsage([]));
});
