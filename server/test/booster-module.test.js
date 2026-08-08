import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.MODULE_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
const booster = (await import('../lib/modules/booster.js')).default;
const { _setBoosterClientForTest, _setRelayForTest, _clearStatusCacheForTest, _setCtwaLookupForTest } =
  await import('../lib/modules/booster.js');
const ctwa = await import('../lib/ctwa.js');

const BIZ = { id: 'b1', name: 'Diva Ost' };
const ROW = { business_id: 'b1', module_key: 'booster', enabled: true, status: 'connected', secrets: {}, settings: {} };
const SENDER = { session_id: '0501234567' };

function stubClient(overrides = {}) {
  return {
    createBoosterLead: async () => { throw new Error('createBoosterLead not stubbed'); },
    lookupBoosterLeadByPhone: async () => { throw new Error('lookupBoosterLeadByPhone not stubbed'); },
    declareMaterialsDone: async () => { throw new Error('declareMaterialsDone not stubbed'); },
    ...overrides,
  };
}

test.afterEach(() => {
  _setBoosterClientForTest(null);
  _setRelayForTest(null);
  _clearStatusCacheForTest();
  _setCtwaLookupForTest(null);
  ctwa._setDbForTest(null);
});

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

// ── T4: status-aware context (F4 mitigation) ─────────────────────────────────
// The webhook's own messages never reach conversation history, so the bot
// would otherwise not know WHERE in the funnel the sender is. The context
// block now reads the lead's status (cached 60s, fail-soft) and steers the
// model per stage.

test('contextProvider without a session stays static — no status lookup at all', async () => {
  let lookedUp = false;
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => { lookedUp = true; return null; },
  }));
  const ctx = await booster.contextProvider(BIZ, ROW);
  assert.ok(ctx.includes('<<ACTION:booster.create_quote_lead'));
  assert.equal(lookedUp, false);
});

test('contextProvider (awaiting_meeting lead): meeting-stage guidance + the callback escalation action', async () => {
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => ({ leadId: 'l1', name: 'דנה', status: 'awaiting_meeting' }),
  }));
  const ctx = await booster.contextProvider(BIZ, ROW, SENDER);
  assert.match(ctx, /פגישת האפיון/, 'steers the model to schedule the characterization meeting in chat');
  assert.ok(ctx.includes('<<ACTION:booster.request_callback{}>>'),
    'an extra-meeting request must route to the callback escalation, not the calendar');
  assert.ok(ctx.includes('<<ACTION:booster.create_quote_lead'), 'the static block is kept');
});

test('contextProvider (payment-stage lead): screenshot guidance, never a self-confirmation of payment', async () => {
  for (const status of ['awaiting_payment', 'payment_proof_sent']) {
    _clearStatusCacheForTest();
    _setBoosterClientForTest(stubClient({
      lookupBoosterLeadByPhone: async () => ({ leadId: 'l1', name: 'דנה', status }),
    }));
    const ctx = await booster.contextProvider(BIZ, ROW, SENDER);
    assert.match(ctx, /צילום/, `status ${status}: asks for the payment screenshot`);
    assert.match(ctx, /אל תאשר/, `status ${status}: forbids confirming payment — only Diva does`);
  }
});

test('contextProvider (materials-stage lead): offers the materials_done action on "סיימתי"', async () => {
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => ({ leadId: 'l1', name: 'דנה', status: 'awaiting_materials' }),
  }));
  const ctx = await booster.contextProvider(BIZ, ROW, SENDER);
  assert.ok(ctx.includes('<<ACTION:booster.materials_done{}>>'));
  assert.match(ctx, /סיימתי/);
});

test('contextProvider caches the status lookup for 60s — one lookup for two builds', async () => {
  let lookups = 0;
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => { lookups++; return { leadId: 'l1', status: 'awaiting_meeting' }; },
  }));
  await booster.contextProvider(BIZ, ROW, SENDER);
  await booster.contextProvider(BIZ, ROW, SENDER);
  assert.equal(lookups, 1, 'a second build inside the TTL must not re-hit the booster');
});

test('the status cache is keyed per sender — one client\'s stage is never served to another', async () => {
  const looked = [];
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async (phone) => {
      looked.push(phone);
      return { leadId: `l-${phone}`, status: phone.endsWith('7') ? 'awaiting_meeting' : 'awaiting_materials' };
    },
  }));
  const a1 = await booster.contextProvider(BIZ, ROW, { session_id: '972501234567' });
  const b1 = await booster.contextProvider(BIZ, ROW, { session_id: '972529999999' });
  const a2 = await booster.contextProvider(BIZ, ROW, { session_id: '972501234567' });

  assert.deepEqual(looked, ['972501234567', '972529999999'],
    'a second sender is a second lookup; a repeat of the first is served from cache');
  assert.ok(a1.includes('<<ACTION:booster.request_callback{}>>'));
  assert.ok(b1.includes('<<ACTION:booster.materials_done{}>>'), 'the second sender gets their OWN stage');
  assert.equal(a2, a1, 'the cached hit is the first sender\'s own context, not the last one looked up');
});

test('a failed status lookup is NOT cached — the very next message retries', async () => {
  let calls = 0;
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => {
      calls++;
      if (calls === 1) throw new Error('booster down');
      return { leadId: 'l1', status: 'awaiting_materials' };
    },
  }));
  const first = await booster.contextProvider(BIZ, ROW, SENDER);
  assert.ok(!first.includes('materials_done'), 'the error falls back to the static context');

  const second = await booster.contextProvider(BIZ, ROW, SENDER);
  assert.equal(calls, 2, 'caching the error would leave the client stage-blind for a full minute');
  assert.ok(second.includes('<<ACTION:booster.materials_done{}>>'), 'the retry picks the real status up');
});

test('contextProvider fail-soft: a status lookup error still returns the static context', async () => {
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => { throw new Error('booster down'); },
  }));
  const ctx = await booster.contextProvider(BIZ, ROW, SENDER);
  assert.ok(ctx.includes('<<ACTION:booster.create_quote_lead'), 'the static block must survive');
  assert.ok(!ctx.includes('request_callback'), 'no invented status guidance on an error');
});

test('the dynamic context never prints a ₪ for any status', async () => {
  const statuses = ['lead', 'signed', 'awaiting_meeting', 'awaiting_payment', 'payment_proof_sent',
    'awaiting_materials', 'materials_declared', 'in_production'];
  for (const status of statuses) {
    _clearStatusCacheForTest();
    _setBoosterClientForTest(stubClient({
      lookupBoosterLeadByPhone: async () => ({ leadId: 'l1', name: 'דנה', status }),
    }));
    const ctx = await booster.contextProvider(BIZ, ROW, SENDER);
    assert.doesNotMatch(ctx, /₪/, `status ${status}: the bot never prints prices of its own`);
  }
});

// ── T4: request_callback ─────────────────────────────────────────────────────

test('request_callback schema is an empty object that drops an injected phone', () => {
  const parsed = booster.actions.request_callback.schema.safeParse({ phone: '0509999999', slot: 'x' });
  assert.ok(parsed.success);
  assert.deepEqual(parsed.data, {}, 'phone only ever comes from sessionCtx.session_id');
});

test('request_callback raises the relay escalation for the SENDER and replies the exact pinned line', async () => {
  const raised = [];
  _setRelayForTest(async (args) => { raised.push(args); return { holdingLine: 'x' }; });
  const r = await booster.actions.request_callback.handler(BIZ, ROW, {}, { session_id: '972501234567' });
  assert.equal(r.confirmationText, 'דיוה תחזור אליך בהקדם 🙂');
  assert.equal(raised.length, 1);
  assert.equal(raised[0].business.id, 'b1');
  assert.equal(raised[0].session_id, '972501234567');
  assert.ok(raised[0].question, 'Diva must see WHAT to do — a callback request');
});

test('request_callback asks to REPLACE the reply rather than be appended to it', async () => {
  _setRelayForTest(async () => ({ holdingLine: 'x' }));
  const r = await booster.actions.request_callback.handler(BIZ, ROW, {}, { session_id: '972501234567' });
  assert.equal(r.replaceResponse, true,
    'appending the pinned line under a model answer like "בטח, אשריין לך שלישי ב-10" contradicts it');
});

test('request_callback still replies the pinned line when the relay fails or is unavailable (F1)', async () => {
  _setRelayForTest(async () => { throw new Error('no escalation template'); });
  const r = await booster.actions.request_callback.handler(BIZ, ROW, {}, { session_id: '972501234567' });
  assert.equal(r.confirmationText, 'דיוה תחזור אליך בהקדם 🙂',
    'the client is answered even when Diva could not be pinged — F1 is a known, accepted gap');
});

// ── T4: materials_done ───────────────────────────────────────────────────────

test('materials_done schema is an empty object that drops an injected phone', () => {
  const parsed = booster.actions.materials_done.schema.safeParse({ phone: '0509999999' });
  assert.ok(parsed.success);
  assert.deepEqual(parsed.data, {});
});

test('materials_done declares to the booster (lead id from the sender\'s phone) and replies the exact ack', async () => {
  let lookedUpPhone = null, declaredLeadId = null;
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async (phone) => { lookedUpPhone = phone; return { leadId: 'l7', status: 'awaiting_materials' }; },
    declareMaterialsDone: async ({ leadId }) => { declaredLeadId = leadId; return { already: false, status: 'materials_declared' }; },
  }));
  const r = await booster.actions.materials_done.handler(BIZ, ROW, {}, { session_id: '972501234567' });
  assert.equal(lookedUpPhone, '972501234567');
  assert.equal(declaredLeadId, 'l7');
  assert.equal(r.confirmationText, 'קיבלתי! עדכנתי את דיוה — היא תעבור על החומרים ותאשר שמתחילים 🙏');
  assert.ok(!r.confirmationText.includes('אושר'), 'never claims the materials were approved');
});

test('materials_done: an already-declared lead gets the exact idempotent line', async () => {
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => ({ leadId: 'l7', status: 'materials_declared' }),
    declareMaterialsDone: async () => ({ already: true, status: 'materials_declared' }),
  }));
  const r = await booster.actions.materials_done.handler(BIZ, ROW, {}, SENDER);
  assert.equal(r.confirmationText, 'כבר עדכנתי את דיוה, היא בודקת 🙏');
});

test('materials_done failure (network/no lead) → the retry line, never a success claim', async () => {
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => ({ leadId: 'l7', status: 'awaiting_materials' }),
    declareMaterialsDone: async () => { throw new Error('fetch failed'); },
  }));
  const failed = await booster.actions.materials_done.handler(BIZ, ROW, {}, SENDER);
  assert.equal(failed.failureText, 'אופס, לא הצלחתי לעדכן — נסו שוב עוד רגע 🙏');

  _clearStatusCacheForTest();
  _setBoosterClientForTest(stubClient({ lookupBoosterLeadByPhone: async () => null }));
  const noLead = await booster.actions.materials_done.handler(BIZ, ROW, {}, SENDER);
  assert.equal(noLead.failureText, 'אופס, לא הצלחתי לעדכן — נסו שוב עוד רגע 🙏');
});

test('materials_done on a 409 wrong_status does not invite a retry that can never succeed', async () => {
  _setBoosterClientForTest(stubClient({
    lookupBoosterLeadByPhone: async () => ({ leadId: 'l7', status: 'awaiting_meeting' }),
    declareMaterialsDone: async () => {
      const e = new Error('booster-client: materials-declared 409 wrong_status');
      e.status = 409; e.code = 'wrong_status';
      throw e;
    },
  }));
  const r = await booster.actions.materials_done.handler(BIZ, ROW, {}, SENDER);
  assert.notEqual(r.failureText, 'אופס, לא הצלחתי לעדכן — נסו שוב עוד רגע 🙏',
    'the lead is not at the materials stage — "נסו שוב עוד רגע" will never come true');
  assert.ok(r.failureText, 'the client is still answered');
  assert.doesNotMatch(r.failureText, /₪/);
  assert.ok(!r.failureText.includes('אושר'), 'never claims an approval');
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

// ── create_quote_lead: CTWA attribution (the funnel's primary entry) ─────────
//
// The Meta ad identity was persisted on message #1 (lib/ctwa.js); lead creation
// is where it finally gets attached. createBoosterLead already forwards `utm`
// as `attribution`, so no client change is needed. All ids below are FAKE.

const CTWA_REFERRAL = {
  source_url: 'https://fb.me/2fakeAdLink',
  source_id: '120210000000000000',
  source_type: 'ad',
  headline: '  אתר תדמית מוכן תוך שבועיים  ',
  body: 'מיני לנדינג — כל מה שצריך כדי לצאת לדרך',
  media_type: 'image',
  ctwa_clid: 'ARAaBbCcDdEeFfGg_fake_clid_0123456789',
};

const quotePayload = () => booster.actions.create_quote_lead.schema.parse({
  name: 'דנה כהן', email: 'dana@example.com', package_id: 'landing',
});

function captureLead() {
  const captured = {};
  _setBoosterClientForTest(stubClient({
    createBoosterLead: async (args) => {
      Object.assign(captured, args);
      return { leadId: 'l1', linkUrl: 'https://booster.divdev.co/flow/tok1', created: true };
    },
  }));
  return captured;
}

test('create_quote_lead attaches the sender\'s CTWA referral to the lead as attribution', async () => {
  ctwa._setDbForTest({ events: [] });
  await ctwa.recordCtwaReferral({ businessId: 'b1', phone: '0501234567', referral: CTWA_REFERRAL });
  const captured = captureLead();

  await booster.actions.create_quote_lead.handler(BIZ, ROW, quotePayload(), SENDER);

  assert.equal(captured.utm.utm_source, 'meta', 'never a guess between facebook and instagram');
  assert.equal(captured.utm.utm_medium, 'ad');
  assert.equal(captured.utm.utm_campaign, null);
  assert.equal(captured.utm.utm_content, 'אתר תדמית מוכן תוך שבועיים', 'the headline, trimmed');
  assert.equal(captured.utm.referrer, 'https://fb.me/2fakeAdLink');
  assert.equal(captured.utm.ad_id, '120210000000000000');
  assert.equal(captured.utm.ctwa_clid, 'ARAaBbCcDdEeFfGg_fake_clid_0123456789', 'verbatim — the Conversions-API join key');
  assert.deepEqual(captured.utm.attribution_raw, CTWA_REFERRAL);
  assert.ok(!('campaign_id' in captured.utm),
    'campaign_id is matched against campaigns.slug on the booster side — an ad id there mis-credits the lead');
});

test('create_quote_lead reads the referral written under the WhatsApp 972… id when the lead creates from 05…', async () => {
  ctwa._setDbForTest({ events: [] });
  await ctwa.recordCtwaReferral({ businessId: 'b1', phone: '972501234567', referral: CTWA_REFERRAL });
  const captured = captureLead();
  await booster.actions.create_quote_lead.handler(BIZ, ROW, quotePayload(), { session_id: '0501234567' });
  assert.equal(captured.utm.ad_id, '120210000000000000', 'both phone shapes meet in the normalized 05… form');
});

test('create_quote_lead looks the referral up scoped to the tenant and keyed by the SENDER', async () => {
  const seen = [];
  _setCtwaLookupForTest(async (args) => { seen.push(args); return null; });
  captureLead();
  await booster.actions.create_quote_lead.handler(BIZ, ROW, quotePayload(), { session_id: '972521234567' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].businessId, 'b1', 'tenant-scoped — never a global read');
  assert.equal(seen[0].phone, '972521234567');
});

test('create_quote_lead sends no attribution at all for a lead with no referral (organic)', async () => {
  ctwa._setDbForTest({ events: [] });
  const captured = captureLead();
  const r = await booster.actions.create_quote_lead.handler(BIZ, ROW, quotePayload(), SENDER);
  assert.equal(captured.utm, undefined, 'an unattributed lead carries no invented attribution');
  assert.ok(r.confirmationText.includes('https://booster.divdev.co/flow/tok1'));
});

test('create_quote_lead still creates the lead when the attribution lookup blows up — losing a tag is a reporting gap, losing a lead is a lost customer', async () => {
  _setCtwaLookupForTest(async () => { throw new Error('module_events unreachable'); });
  const captured = captureLead();
  const r = await booster.actions.create_quote_lead.handler(BIZ, ROW, quotePayload(), SENDER);
  assert.ok(r.confirmationText.includes('https://booster.divdev.co/flow/tok1'), 'the lead is created regardless');
  assert.equal(captured.utm, undefined);
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
