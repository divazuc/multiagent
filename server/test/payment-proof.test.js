// server/test/payment-proof.test.js
//
// Task 17: a client mid-payment sends a screenshot in WhatsApp. These tests
// exercise handlePaymentProofImage in isolation via its test seams (same
// convention as booster-module.test.js / booster-webhook.test.js) — no real
// Supabase, Graph API, or booster HTTP calls.
// payment-proof.js -> supabase.js calls createClient(SUPABASE_URL, ...) at
// module-evaluation time, and ESM hoists static imports ahead of this file's
// own top-level statements (same issue booster-webhook.test.js hit) — so the
// env vars must be set BEFORE the module is loaded, via a dynamic import().
process.env.SUPABASE_URL = 'http://supabase.invalid';
process.env.SUPABASE_SERVICE_KEY = 'stub-service-key';

import test from 'node:test';
import assert from 'node:assert/strict';
const {
  handlePaymentProofImage,
  _setBoosterClientForTest,
  _setMediaDownloaderForTest,
  _setBusinessLookupForTest,
  _setSendForTest,
} = await import('../lib/payment-proof.js');

const IMAGE_VALUE = (overrides = {}) => ({
  metadata: { phone_number_id: 'pnid-1' },
  messages: [{
    from: '972501234567',
    type: 'image',
    image: { id: 'media-1', mime_type: 'image/jpeg' },
    ...overrides,
  }],
});

function stubClient(overrides = {}) {
  return {
    lookupBoosterLeadByPhone: async () => { throw new Error('lookupBoosterLeadByPhone not stubbed'); },
    forwardPaymentProof: async () => { throw new Error('forwardPaymentProof not stubbed'); },
    ...overrides,
  };
}

test.afterEach(() => {
  _setBoosterClientForTest(null);
  _setMediaDownloaderForTest(null);
  _setBusinessLookupForTest(null);
  _setSendForTest(null);
});

test('payment-stage sender image (awaiting_payment): forwarded to the booster + exact ack reply', async () => {
  let forwardedWith = null;
  let sentWith = null;
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async (phone) => {
      assert.equal(phone, '972501234567');
      return { leadId: 'lead-1', status: 'awaiting_payment' };
    },
    forwardPaymentProof: async (args) => { forwardedWith = args; return { screenshotId: 's1' }; },
  }));
  _setMediaDownloaderForTest(async (mediaId, token) => {
    assert.equal(mediaId, 'media-1');
    assert.equal(token, 'tok-biz-1');
    return { buffer: Buffer.from('fake-png-bytes'), mime: 'image/jpeg' };
  });
  _setBusinessLookupForTest(async (phoneNumberId) => {
    assert.equal(phoneNumberId, 'pnid-1');
    return { businessId: 'biz-1', token: 'tok-biz-1' };
  });
  _setSendForTest(async (args) => { sentWith = args; return { messages: [{ id: 'wamid.1' }] }; });

  const handled = await handlePaymentProofImage(IMAGE_VALUE());

  assert.equal(handled, true);
  assert.equal(forwardedWith.leadId, 'lead-1');
  assert.equal(forwardedWith.mime, 'image/jpeg');
  assert.equal(forwardedWith.imageBase64, Buffer.from('fake-png-bytes').toString('base64'));
  assert.deepEqual(sentWith, { to: '972501234567', text: 'קיבלתי, בודקת ומעדכנת 🙏', businessId: 'biz-1' });
  // The one hard rule from spec §אימות התשלום: never imply the payment is confirmed.
  assert.ok(!sentWith.text.includes('אושר'));
});

test('payment-stage sender image (payment_proof_sent — a second screenshot): still forwarded + acked', async () => {
  let forwardCalled = false;
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => ({ leadId: 'lead-2', status: 'payment_proof_sent' }),
    forwardPaymentProof: async () => { forwardCalled = true; return { screenshotId: 's2' }; },
  }));
  _setMediaDownloaderForTest(async () => ({ buffer: Buffer.from('x'), mime: 'image/png' }));
  _setBusinessLookupForTest(async () => ({ businessId: 'biz-1', token: 'tok' }));
  let sentText = null;
  _setSendForTest(async ({ text }) => { sentText = text; return { messages: [{ id: 'w' }] }; });

  const handled = await handlePaymentProofImage(IMAGE_VALUE());
  assert.equal(handled, true);
  assert.ok(forwardCalled);
  assert.equal(sentText, 'קיבלתי, בודקת ומעדכנת 🙏');
});

test('non-payment-stage sender image (e.g. status "lead"): untouched — no forward, no send, caller falls back', async () => {
  let forwardCalled = false, sendCalled = false;
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => ({ leadId: 'lead-3', status: 'lead' }),
    forwardPaymentProof: async () => { forwardCalled = true; },
  }));
  _setSendForTest(async () => { sendCalled = true; });

  const handled = await handlePaymentProofImage(IMAGE_VALUE());

  assert.equal(handled, false);
  assert.equal(forwardCalled, false);
  assert.equal(sendCalled, false);
});

test('sender with no booster lead at all: untouched — caller falls back to today\'s behavior', async () => {
  _setBoosterClientForTest(stubClient({ lookupBoosterLeadByPhone: async () => null }));
  const handled = await handlePaymentProofImage(IMAGE_VALUE());
  assert.equal(handled, false);
});

test('lead lookup throws (booster unreachable): logged, untouched — never guesses a sender into the payment flow', async () => {
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => { throw new Error('network down'); },
  }));
  const handled = await handlePaymentProofImage(IMAGE_VALUE());
  assert.equal(handled, false);
});

test('non-image unsupported message (e.g. video) from a payment-stage sender: untouched regardless of status', async () => {
  let lookupCalled = false;
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => { lookupCalled = true; return { leadId: 'l', status: 'awaiting_payment' }; },
  }));
  const handled = await handlePaymentProofImage(IMAGE_VALUE({ type: 'video', video: { id: 'v1' } }));
  assert.equal(handled, false);
  assert.equal(lookupCalled, false, 'must not even look up the lead for a non-image type');
});

test('media download failure: fallback reply sent, forward never attempted, never throws', async () => {
  let forwardCalled = false;
  let sentText = null;
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => ({ leadId: 'lead-4', status: 'awaiting_payment' }),
    forwardPaymentProof: async () => { forwardCalled = true; },
  }));
  _setMediaDownloaderForTest(async () => { throw new Error('graph 500'); });
  _setBusinessLookupForTest(async () => ({ businessId: 'biz-1', token: 'tok' }));
  _setSendForTest(async ({ text }) => { sentText = text; return { messages: [{ id: 'w' }] }; });

  const handled = await handlePaymentProofImage(IMAGE_VALUE());

  assert.equal(handled, true);
  assert.equal(forwardCalled, false);
  assert.equal(sentText, 'אופס, הייתה תקלה בקליטת הצילום 🙈 אפשר לנסות לשלוח שוב, ואם זה נמשך אני אבדוק ידנית.');
});

test('forward-to-booster failure (after a successful download): fallback reply sent, never throws', async () => {
  let sentText = null;
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => ({ leadId: 'lead-5', status: 'awaiting_payment' }),
    forwardPaymentProof: async () => { throw new Error('booster 500'); },
  }));
  _setMediaDownloaderForTest(async () => ({ buffer: Buffer.from('x'), mime: 'image/png' }));
  _setBusinessLookupForTest(async () => ({ businessId: 'biz-1', token: 'tok' }));
  _setSendForTest(async ({ text }) => { sentText = text; return { messages: [{ id: 'w' }] }; });

  const handled = await handlePaymentProofImage(IMAGE_VALUE());

  assert.equal(handled, true);
  assert.equal(sentText, 'אופס, הייתה תקלה בקליטת הצילום 🙈 אפשר לנסות לשלוח שוב, ואם זה נמשך אני אבדוק ידנית.');
});

test('no WhatsApp credentials for the receiving number: logged, handled (no reply possible), never throws', async () => {
  let sendCalled = false;
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => ({ leadId: 'lead-6', status: 'awaiting_payment' }),
  }));
  _setBusinessLookupForTest(async () => null);
  _setSendForTest(async () => { sendCalled = true; });

  const handled = await handlePaymentProofImage(IMAGE_VALUE());

  assert.equal(handled, true);
  assert.equal(sendCalled, false);
});

test('ack reply is sent even when the ack send itself is the thing to verify: exact-string pin, not a partial match', async () => {
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => ({ leadId: 'lead-7', status: 'awaiting_payment' }),
    forwardPaymentProof: async () => ({ screenshotId: 's' }),
  }));
  _setMediaDownloaderForTest(async () => ({ buffer: Buffer.from('x'), mime: null }));
  _setBusinessLookupForTest(async () => ({ businessId: 'biz-1', token: 'tok' }));
  let sentText = null;
  _setSendForTest(async ({ text }) => { sentText = text; return { messages: [{ id: 'w' }] }; });

  await handlePaymentProofImage(IMAGE_VALUE());
  assert.equal(sentText, 'קיבלתי, בודקת ומעדכנת 🙏');
});

test('missing image id / malformed payload: returns false without touching any collaborator', async () => {
  let anyCalled = false;
  _setBoosterClientForTest(stubClient({ lookupBoosterLeadByPhone: async () => { anyCalled = true; } }));
  const handled = await handlePaymentProofImage({ metadata: { phone_number_id: 'pnid-1' }, messages: [{ from: 'x', type: 'image' }] });
  assert.equal(handled, false);
  assert.equal(anyCalled, false);
});
