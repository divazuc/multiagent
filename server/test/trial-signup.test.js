import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.MODULE_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

const trialModule = (await import('../lib/modules/trial-signup.js')).default;
const trial = await import('../lib/modules/trial-signup.js');
const engine = await import('../lib/modules/engine.js');
const { extractModuleAction } = await import('../lib/modules/actions.js');

const BIZ = { id: 'biz-ck', name: 'קרוספיט קידס — הדרקונים' };
const PARENT_PHONE = '972501234567';

const events = [];
engine._setDbForTest({
  enabledRows: [{ business_id: 'biz-ck', module_key: 'trial_signup', enabled: true, settings: {}, secrets: {}, status: 'connected' }],
  onEvent: (e) => events.push(e),
});

// The handler also feeds the leads board (lib/leads.js) — that seam has its
// own tests (leads-wiring.test.js); here it must simply never interfere, so
// the module reads as disabled instead of reaching for real supabase env.
const leadsLib = await import('../lib/leads.js');
leadsLib._setDbForTest({ isEnabled: async () => false });

// Pinned client-facing copy — the exact confirmation a parent receives.
const CONFIRM = 'רשמתי! המאמנת תחזור אליכם לתיאום סופי 🙂';

test('the module context tells the model what to collect and the exact action format', async () => {
  const ctx = await trialModule.contextProvider(BIZ, {}, { session_id: PARENT_PHONE });
  assert.ok(ctx.includes('שם ההורה'));
  assert.ok(ctx.includes('שם הילד/ה והגיל'));
  assert.ok(ctx.includes('יום מועדף'));
  assert.ok(ctx.includes('<<ACTION:trial_signup.submit_trial_request'));
  // the phone must never be asked for — it rides the channel
  assert.ok(ctx.includes('אל תבקש/י מספר טלפון'));
});

test('happy path: collect → pinned confirmation → relay called with the structured summary', async () => {
  const relayed = [];
  trial._setRelayForTest(async (args) => { relayed.push(args); return { holdingLine: 'x' }; });

  // The model's reply as the pipeline sees it — text plus the ACTION marker.
  const modelReply = 'מעולה, רושמת אתכם! ' +
    '<<ACTION:trial_signup.submit_trial_request{"parent_name":"שירה לוי","child_name":"יובל","child_age":"8","preferred_day":"רביעי"}>>';
  const { text, action } = extractModuleAction(modelReply);
  assert.equal(action.module, 'trial_signup');
  assert.ok(!text.includes('ACTION'));

  const out = await engine.executeModuleAction(BIZ, action, { session_id: PARENT_PHONE });

  // Confirmation replaces the model's text — a module answer the coach can trust.
  assert.equal(out.text, CONFIRM);
  assert.equal(out.replaceResponse, true);

  // The relay got ONE structured summary with every collected field and the
  // channel-known phone.
  assert.equal(relayed.length, 1);
  assert.equal(relayed[0].business.id, 'biz-ck');
  assert.equal(relayed[0].session_id, PARENT_PHONE);
  assert.equal(relayed[0].reason, 'trial_signup');
  const q = relayed[0].question;
  assert.ok(q.includes('בקשת אימון ניסיון חדשה'));
  assert.ok(q.includes('הורה: שירה לוי'));
  assert.ok(q.includes('ילד/ה: יובל (גיל 8)'));
  assert.ok(q.includes('יום מועדף: רביעי'));
  assert.ok(q.includes(`טלפון ההורה: ${PARENT_PHONE}`));

  trial._setRelayForTest(null);
});

test('the phone can never come from the model — schema strips it, summary uses the session', async () => {
  const relayed = [];
  trial._setRelayForTest(async (args) => { relayed.push(args); return { holdingLine: 'x' }; });

  const out = await engine.executeModuleAction(BIZ, {
    module: 'trial_signup', name: 'submit_trial_request',
    payload: { parent_name: 'דנה', child_name: 'איתי', phone: '0500000000' }, // hallucinated phone
  }, { session_id: PARENT_PHONE });

  assert.equal(out.text, CONFIRM);
  assert.ok(relayed[0].question.includes(`טלפון ההורה: ${PARENT_PHONE}`));
  assert.ok(!relayed[0].question.includes('0500000000'));

  trial._setRelayForTest(null);
});

test('optional fields missing: age/day omitted gracefully, still relayed and confirmed', async () => {
  const relayed = [];
  trial._setRelayForTest(async (args) => { relayed.push(args); return { holdingLine: 'x' }; });

  const out = await engine.executeModuleAction(BIZ, {
    module: 'trial_signup', name: 'submit_trial_request',
    payload: { parent_name: 'דנה', child_name: 'איתי' },
  }, { session_id: PARENT_PHONE });

  assert.equal(out.text, CONFIRM);
  assert.ok(relayed[0].question.includes('ילד/ה: איתי\n'));
  assert.ok(relayed[0].question.includes('יום מועדף: לא צוין — לתאם טלפונית'));

  trial._setRelayForTest(null);
});

test('a numeric child_age is normalised, and junk in an optional field never blocks the signup', async () => {
  const relayed = [];
  trial._setRelayForTest(async (args) => { relayed.push(args); return { holdingLine: 'x' }; });

  const out = await engine.executeModuleAction(BIZ, {
    module: 'trial_signup', name: 'submit_trial_request',
    payload: { parent_name: 'רון', child_name: 'עמית', child_age: 9, preferred_day: '' },
  }, { session_id: PARENT_PHONE });

  // preferred_day:"" fails its min(1) and is .catch-dropped rather than
  // failing the whole payload — the parent still gets their confirmation.
  assert.equal(out.text, CONFIRM);
  assert.ok(relayed[0].question.includes('(גיל 9)'));

  trial._setRelayForTest(null);
});

test('missing REQUIRED fields (no child name) → invalid_payload, no confirmation, no relay', async () => {
  const relayed = [];
  trial._setRelayForTest(async (args) => { relayed.push(args); return { holdingLine: 'x' }; });
  events.length = 0;

  const out = await engine.executeModuleAction(BIZ, {
    module: 'trial_signup', name: 'submit_trial_request',
    payload: { parent_name: 'דנה' },
  }, { session_id: PARENT_PHONE });

  assert.equal(out.text, null);
  assert.equal(relayed.length, 0);
  assert.ok(events.some(e => e.event_type === 'action.submit_trial_request_failed'));

  trial._setRelayForTest(null);
});

test('relay failure or refusal never blocks the parent-facing confirmation', async () => {
  // refusal (raiseEscalation returned null — e.g. template not configured)
  trial._setRelayForTest(async () => null);
  let out = await engine.executeModuleAction(BIZ, {
    module: 'trial_signup', name: 'submit_trial_request',
    payload: { parent_name: 'דנה', child_name: 'איתי' },
  }, { session_id: PARENT_PHONE });
  assert.equal(out.text, CONFIRM);

  // hard failure (relay threw)
  trial._setRelayForTest(async () => { throw new Error('relay down'); });
  out = await engine.executeModuleAction(BIZ, {
    module: 'trial_signup', name: 'submit_trial_request',
    payload: { parent_name: 'דנה', child_name: 'איתי' },
  }, { session_id: PARENT_PHONE });
  assert.equal(out.text, CONFIRM);

  trial._setRelayForTest(null);
});

test('the module is registered in the catalog under trial_signup', async () => {
  const { MODULES } = await import('../lib/modules/registry.js');
  assert.equal(MODULES.trial_signup?.key, 'trial_signup');
  assert.ok(MODULES.trial_signup.actions.submit_trial_request);
});

test('a payload the engine executes is logged to module_events with its detail', async () => {
  trial._setRelayForTest(async () => ({ holdingLine: 'x' }));
  events.length = 0;
  await engine.executeModuleAction(BIZ, {
    module: 'trial_signup', name: 'submit_trial_request',
    payload: { parent_name: 'שירה', child_name: 'יובל', child_age: '8' },
  }, { session_id: PARENT_PHONE });
  // The durable record: even if the relay is refused, the payload survives here.
  const logged = events.find(e => e.event_type === 'action.submit_trial_request');
  assert.ok(logged);
  assert.equal(logged.detail.payload.parent_name, 'שירה');
  trial._setRelayForTest(null);
});
