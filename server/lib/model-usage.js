// Cost-efficiency pass (2026-08-12): the account ran out of Anthropic credits
// mid-pilot with zero visibility into which business/model/call was burning
// tokens. This is the pure pricing/aggregation half — extractUsage() turns one
// API response's `usage` block into a priced record, sumUsage() rolls a run's
// calls into one total. lib/logger.js#logUsage is what actually lands these in
// agent_runs.steps (jsonb, no schema change); this file has no DB dependency
// so it's cheap to unit test exhaustively.

// $ per 1,000,000 tokens, first-party API list price. Only the two models
// agents/conversation.js is allowed to run (its ALLOWED_CONVERSATION_MODELS
// allow-list) are priced — an unpriced model fails soft (cost_usd: null)
// rather than throwing, so a future model addition never breaks a live turn.
export const PRICE_PER_MTOK = Object.freeze({
  'claude-sonnet-4-6': Object.freeze({ input: 3.00, output: 15.00 }),
  'claude-haiku-4-5-20251001': Object.freeze({ input: 1.00, output: 5.00 }),
});

// Cache economics (Anthropic docs): a write at the default 5-minute ephemeral
// TTL costs 1.25x the base input price; a cache read costs 0.1x. This
// codebase never sets `ttl: '1h'` (agents/conversation.js's cache_control is
// always the bare `{type: 'ephemeral'}` default), so the 5-minute multiplier
// is the only one that applies here.
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.10;

const MTOK = 1_000_000;

// Pure: tokens in, USD out. Returns null (not 0) for a model with no price
// entry — the caller decides how to treat "unknown", and sumUsage() below
// keeps unpriced calls visibly separate from priced ones rather than folding
// them into the total as if they cost nothing.
export function priceUsage({ model, input_tokens = 0, output_tokens = 0, cache_creation_input_tokens = 0, cache_read_input_tokens = 0 }) {
  const price = PRICE_PER_MTOK[model];
  if (!price) return null;
  const cost =
    (input_tokens * price.input) / MTOK +
    (output_tokens * price.output) / MTOK +
    (cache_creation_input_tokens * price.input * CACHE_WRITE_5M_MULTIPLIER) / MTOK +
    (cache_read_input_tokens * price.input * CACHE_READ_MULTIPLIER) / MTOK;
  // 8 decimal places — individual calls are fractions of a cent; rounding to
  // fewer would zero out most of them.
  return Math.round(cost * 1e8) / 1e8;
}

// Normalizes one Anthropic response's `usage` object (whatever fields are
// present — the SDK omits cache fields entirely on a request with no
// cache_control) into the fixed record shape the task and the schema comment
// on agent_runs.steps expect.
export function extractUsage(usage, model) {
  const u = usage ?? {};
  const record = {
    model,
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
  };
  record.cost_usd = priceUsage(record);
  return record;
}

// Rolls a run's per-call usage records into one totals object — the
// `usage_total` step. Unpriced calls contribute 0 to cost_usd but are counted
// separately (unpriced_calls) so a missing price entry is visible in the
// data rather than silently under-reporting spend.
export function sumUsage(entries) {
  const totals = {
    calls: 0, input_tokens: 0, output_tokens: 0,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    cost_usd: 0, priced_calls: 0, unpriced_calls: 0,
  };
  for (const e of entries ?? []) {
    totals.calls += 1;
    totals.input_tokens += e.input_tokens ?? 0;
    totals.output_tokens += e.output_tokens ?? 0;
    totals.cache_creation_input_tokens += e.cache_creation_input_tokens ?? 0;
    totals.cache_read_input_tokens += e.cache_read_input_tokens ?? 0;
    if (typeof e.cost_usd === 'number') { totals.cost_usd += e.cost_usd; totals.priced_calls += 1; }
    else { totals.unpriced_calls += 1; }
  }
  totals.cost_usd = Math.round(totals.cost_usd * 1e8) / 1e8;
  return totals;
}
