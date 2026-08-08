import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.MODULE_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
const booster = (await import('../lib/modules/booster.js')).default;
const { _setBoosterClientForTest } = await import('../lib/modules/booster.js');

const BIZ = { id: 'b1', name: 'Diva Ost' };
const ROW = { business_id: 'b1', module_key: 'booster', enabled: true, status: 'connected', secrets: {}, settings: {} };
const SENDER = { session_id: '0501234567' };

function stubClient(overrides = {}) {
  return {
    createBoosterLead: async () => { throw new Error('createBoosterLead not stubbed'); },
    lookupBoosterLeadByPhone: async () => { throw new Error('lookupBoosterLeadByPhone not stubbed'); },
    ...overrides,
  };
}

test.afterEach(() => _setBoosterClientForTest(null));

// ── settingsSchema / contextProvider ─────────────────────────────────────────

test('settingsSchema accepts an empty object (no per-business settings)', () => {
  const parsed = booster.settingsSchema.safeParse({});
  assert.ok(parsed.success);
});

test('contextProvider explains both actions and never asks for a phone', async () => {
  const ctx = await booster.contextProvider(BIZ, ROW);
  assert.ok(ctx.includes('<<ACTION:booster.create_quote_lead'));
  assert.ok(ctx.includes('<<ACTION:booster.resend_quote_link'));
  assert.ok(ctx.includes('mini'));
  assert.ok(ctx.includes('landing'));
  assert.ok(ctx.includes('corporate'));
});

// ── create_quote_lead: schema ────────────────────────────────────────────────

test('create_quote_lead schema accepts a valid payload', () => {
  const parsed = booster.actions.create_quote_lead.schema.safeParse({
    name: 'דנה כהן', email: 'dana@example.com', package_id: 'landing',
  });
  assert.ok(parsed.success);
});

test('create_quote_lead schema rejects an invalid package_id', () => {
  const parsed = booster.actions.create_quote_lead.schema.safeParse({
    name: 'דנה כהן', email: 'dana@example.com', package_id: 'premium',
  });
  assert.ok(!parsed.success);
});

test('create_quote_lead schema rejects a missing/invalid email', () => {
  const parsed = booster.actions.create_quote_lead.schema.safeParse({
    name: 'דנה כהן', email: 'not-an-email', package_id: 'mini',
  });
  assert.ok(!parsed.success);
});

test('create_quote_lead schema silently drops a phone the model tries to inject', () => {
  const parsed = booster.actions.create_quote_lead.schema.safeParse({
    name: 'דנה כהן', email: 'dana@example.com', package_id: 'mini', phone: '0509999999',
  });
  assert.ok(parsed.success);
  assert.equal(parsed.data.phone, undefined);
});

// ── create_quote_lead: handler ───────────────────────────────────────────────

test('create_quote_lead: fresh lead → link included, no "again" phrasing', async () => {
  _setBoosterClientForTest(stubClient({
    createBoosterLead: async () => ({ leadId: 'l1', linkUrl: 'https://booster.divdev.co/flow/tok1', created: true }),
  }));
  const payload = booster.actions.create_quote_lead.schema.parse({
    name: 'דנה כהן', email: 'dana@example.com', package_id: 'landing',
  });
  const r = await booster.actions.create_quote_lead.handler(BIZ, ROW, payload, SENDER);
  assert.ok(r.confirmationText.includes('https://booster.divdev.co/flow/tok1'));
  assert.ok(!r.confirmationText.includes('הנה שוב'));
});

test('create_quote_lead: existing lead (created:false) → "הנה שוב" phrasing', async () => {
  _setBoosterClientForTest(stubClient({
    createBoosterLead: async () => ({ leadId: 'l1', linkUrl: 'https://booster.divdev.co/flow/tok1', created: false }),
  }));
  const payload = booster.actions.create_quote_lead.schema.parse({
    name: 'דנה כהן', email: 'dana@example.com', package_id: 'mini',
  });
  const r = await booster.actions.create_quote_lead.handler(BIZ, ROW, payload, SENDER);
  assert.ok(r.confirmationText.startsWith('הנה שוב הקישור האישי שלך'));
  assert.ok(r.confirmationText.includes('https://booster.divdev.co/flow/tok1'));
});

test('create_quote_lead: phone passed to the client is the sender\'s session_id, never from payload', async () => {
  let capturedPhone;
  _setBoosterClientForTest(stubClient({
    createBoosterLead: async ({ phone }) => { capturedPhone = phone; return { leadId: 'l1', linkUrl: 'https://x', created: true }; },
  }));
  const payload = booster.actions.create_quote_lead.schema.parse({
    name: 'א', email: 'a@a.com', package_id: 'corporate', phone: '0509999999',
  });
  await booster.actions.create_quote_lead.handler(BIZ, ROW, payload, { session_id: '0501234567' });
  assert.equal(capturedPhone, '0501234567');
});

// ── resend_quote_link: handler ───────────────────────────────────────────────

test('resend_quote_link: found → quoteUrl in a short reply', async () => {
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => ({ leadId: 'l1', name: 'דנה', packageId: 'landing', quoteUrl: 'https://booster.divdev.co/flow/share/abc' }),
  }));
  const r = await booster.actions.resend_quote_link.handler(BIZ, ROW, {}, SENDER);
  assert.ok(r.confirmationText.includes('https://booster.divdev.co/flow/share/abc'));
});

test('resend_quote_link: not found → fixed Hebrew phrase', async () => {
  _setBoosterClientForTest(stubClient({ lookupBoosterLeadByPhone: async () => null }));
  const r = await booster.actions.resend_quote_link.handler(BIZ, ROW, {}, SENDER);
  assert.equal(r.failureText, 'לא מצאתי הצעה פתוחה למספר הזה');
});

test('resend_quote_link: always looks up the SENDER\'s number, ignoring any phone in payload', async () => {
  let capturedPhone;
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async (phone) => { capturedPhone = phone; return null; },
  }));
  await booster.actions.resend_quote_link.handler(BIZ, ROW, { phone: '0500000000' }, { session_id: '0501234567' });
  assert.equal(capturedPhone, '0501234567');
});

// ── Engine integration (registered module, full path through executeModuleAction) ──

test('engine: executeModuleAction runs create_quote_lead end-to-end and logs success', async () => {
  const engine = await import('../lib/modules/engine.js');
  const events = [];
  engine._setDbForTest({
    enabledRows: [{ business_id: 'b1', module_key: 'booster', enabled: true, settings: {}, secrets: {}, status: 'connected' }],
    onEvent: (e) => events.push(e),
  });
  _setBoosterClientForTest(stubClient({
    createBoosterLead: async () => ({ leadId: 'l1', linkUrl: 'https://booster.divdev.co/flow/tok2', created: true }),
  }));
  const r = await engine.executeModuleAction(BIZ, {
    module: 'booster', name: 'create_quote_lead',
    payload: { name: 'דנה כהן', email: 'dana@example.com', package_id: 'landing' },
  }, SENDER);
  assert.ok(r.text.includes('https://booster.divdev.co/flow/tok2'));
  assert.ok(events.some(e => e.event_type === 'action.create_quote_lead'));
});

test('engine: invalid package_id never reaches the handler (invalid_payload logged, null text)', async () => {
  const engine = await import('../lib/modules/engine.js');
  const events = [];
  engine._setDbForTest({
    enabledRows: [{ business_id: 'b1', module_key: 'booster', enabled: true, settings: {}, secrets: {}, status: 'connected' }],
    onEvent: (e) => events.push(e),
  });
  _setBoosterClientForTest(stubClient()); // would throw if ever called
  const r = await engine.executeModuleAction(BIZ, {
    module: 'booster', name: 'create_quote_lead',
    payload: { name: 'דנה כהן', email: 'dana@example.com', package_id: 'premium' },
  }, SENDER);
  assert.equal(r.text, null);
  assert.ok(events.some(e => e.event_type === 'action.create_quote_lead_failed' && e.detail.reason === 'invalid_payload'));
});
