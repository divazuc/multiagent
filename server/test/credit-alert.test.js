import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
process.env.TELEGRAM_CHAT_ID = 'test-chat-id';

const { isCreditExhaustionError, alertCreditExhaustion, ALERT_TEXT, _setNowForTest, _resetCreditAlertForTest } =
  await import('../lib/credit-alert.js');
const { _setTelegramFetchForTest } = await import('../lib/approvals.js');

function creditError(overrides = {}) {
  return Object.assign(
    new Error('Your credit balance is too low to access the Claude API. Please go to Plans & Billing to upgrade or purchase credits.'),
    { status: 400, ...overrides },
  );
}

test.beforeEach(() => {
  _resetCreditAlertForTest();
  _setTelegramFetchForTest(null);
});
test.afterEach(() => {
  _resetCreditAlertForTest();
  _setTelegramFetchForTest(null);
});

test('isCreditExhaustionError: matches a 400 whose message names the credit balance', () => {
  assert.equal(isCreditExhaustionError(creditError()), true);
});

test('isCreditExhaustionError: a 400 for an unrelated reason does not match', () => {
  assert.equal(isCreditExhaustionError(Object.assign(new Error('messages: roles must alternate'), { status: 400 })), false);
});

test('isCreditExhaustionError: a 429 rate-limit error does not match even with similar wording', () => {
  assert.equal(isCreditExhaustionError(Object.assign(new Error('credit balance exceeded'), { status: 429 })), false);
});

test('isCreditExhaustionError: null/undefined never throws', () => {
  assert.equal(isCreditExhaustionError(null), false);
  assert.equal(isCreditExhaustionError(undefined), false);
  assert.equal(isCreditExhaustionError({}), false);
});

test('alertCreditExhaustion: a matching error sends exactly the owner-approved Hebrew text via Telegram', async () => {
  const sent = [];
  _setTelegramFetchForTest(async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    return { ok: true };
  });
  const fired = await alertCreditExhaustion(creditError());
  assert.equal(fired, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, ALERT_TEXT);
  assert.match(sent[0].text, /console\.anthropic\.com/);
});

test('alertCreditExhaustion: a non-matching error is a silent no-op', async () => {
  const sent = [];
  _setTelegramFetchForTest(async (url, opts) => { sent.push(opts); return { ok: true }; });
  const fired = await alertCreditExhaustion(new Error('some other failure'));
  assert.equal(fired, false);
  assert.equal(sent.length, 0);
});

test('alertCreditExhaustion: rate-limited to once per 60 minutes', async () => {
  const sent = [];
  _setTelegramFetchForTest(async (url, opts) => { sent.push(opts); return { ok: true }; });
  let clock = 1_000_000;
  _setNowForTest(() => clock);

  assert.equal(await alertCreditExhaustion(creditError()), true, 'first alert fires');
  clock += 30 * 60 * 1000; // 30 minutes later — still inside the cooldown
  assert.equal(await alertCreditExhaustion(creditError()), false, 'within the hour: suppressed');
  clock += 31 * 60 * 1000; // now 61 minutes after the first alert
  assert.equal(await alertCreditExhaustion(creditError()), true, 'past 60 minutes: fires again');

  assert.equal(sent.length, 2);
});

test('alertCreditExhaustion: fail-soft when Telegram is not configured — logs, does not throw', async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  try {
    const fired = await alertCreditExhaustion(creditError());
    assert.equal(fired, false);
  } finally {
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
    process.env.TELEGRAM_CHAT_ID = 'test-chat-id';
  }
});

test('alertCreditExhaustion: a failed Telegram send is caught, never thrown', async () => {
  _setTelegramFetchForTest(async () => { throw new Error('network down'); });
  await assert.doesNotReject(() => alertCreditExhaustion(creditError()));
});
