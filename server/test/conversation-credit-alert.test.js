// Cost-efficiency pass, item 6: a credit-balance 400 from ANY Anthropic call
// agents/conversation.js makes must trip the owner's Telegram alert. This is
// the wiring test — lib/credit-alert.test.js already covers the matcher and
// the cooldown in isolation.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
process.env.TELEGRAM_CHAT_ID = 'test-chat-id';

const { runConversation, _setMessagesCreateForTest } = await import('../agents/conversation.js');
const { _setTelegramFetchForTest } = await import('../lib/approvals.js');
const { _resetCreditAlertForTest, ALERT_TEXT } = await import('../lib/credit-alert.js');

function creditError() {
  return Object.assign(
    new Error('Your credit balance is too low to access the Claude API. Please go to Plans & Billing to upgrade or purchase credits.'),
    { status: 400 },
  );
}

test.beforeEach(() => _resetCreditAlertForTest());
test.afterEach(() => {
  _setMessagesCreateForTest(null);
  _setTelegramFetchForTest(null);
  _resetCreditAlertForTest();
});

test('a credit-exhaustion error from the intent-detection call trips the Telegram alert and still returns a clean error result', async () => {
  const sent = [];
  _setTelegramFetchForTest(async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true }; });
  _setMessagesCreateForTest(async () => { throw creditError(); });

  const out = await runConversation({
    message: 'היי', session_id: 's1',
    context: {
      business_id: 'b1', business_profile: { business_name: 'X', agent_mode: 'support' },
      persona: {}, guardrails: {}, hebrew_patterns: {},
      conversation_history: [], missing_qualification_data: [], current_stage: 'greeting',
    },
  });

  assert.equal(out.status, 'error');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, ALERT_TEXT);
});

test('an unrelated model error does NOT trip the Telegram alert', async () => {
  const sent = [];
  _setTelegramFetchForTest(async (url, opts) => { sent.push(opts); return { ok: true }; });
  _setMessagesCreateForTest(async () => { throw new Error('some unrelated failure'); });

  await runConversation({
    message: 'היי', session_id: 's1',
    context: {
      business_id: 'b1', business_profile: { business_name: 'X', agent_mode: 'support' },
      persona: {}, guardrails: {}, hebrew_patterns: {},
      conversation_history: [], missing_qualification_data: [], current_stage: 'greeting',
    },
  });

  assert.equal(sent.length, 0);
});
