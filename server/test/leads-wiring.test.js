// The leads module's two conversation-driven seams, tested through the REAL
// callers rather than by calling lib/leads.js directly:
//   owner echo    → lib/coexistence.js#handleOwnerEcho   → 'contacted'
//   trial signup  → engine.executeModuleAction(trial_signup) → 'trial_signed_up'
// Both must be gated (coexistence flag / leads module) and both must fail SOFT
// — the standdown and the parent's pinned confirmation never depend on the
// lead write landing.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.MODULE_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

const coex = await import('../lib/coexistence.js');
const leads = await import('../lib/leads.js');
const engine = await import('../lib/modules/engine.js');
const trial = await import('../lib/modules/trial-signup.js');

const PNID = '111222333444555';
const BIZ_ID = 'biz-ck';
const CUSTOMER = '972501234567';
const CONFIRM = 'רשמתי! המאמנת תחזור אליכם לתיאום סופי 🙂';

// Same in-memory fake as leads.test.js — small enough to keep test-local.
function makeFakeLeadsDb({ enabled = true, rows = [], failLeads = false } = {}) {
  let seq = 0;
  const store = rows.map(r => ({ ...r }));
  const boom = () => { throw new Error('relation "leads" does not exist'); };
  return {
    store,
    async isEnabled() { return enabled; },
    async getLead(businessId, phone) {
      if (failLeads) boom();
      return store.find(l => l.business_id === businessId && l.phone === phone) ?? null;
    },
    async getLeadById(businessId, id) {
      if (failLeads) boom();
      return store.find(l => l.business_id === businessId && l.id === id) ?? null;
    },
    async insertLead(row) {
      if (failLeads) boom();
      const withId = { id: `lead-${++seq}`, ...row };
      store.push(withId);
      return withId;
    },
    async updateLead(id, patch) {
      if (failLeads) boom();
      const i = store.findIndex(l => l.id === id);
      if (i === -1) throw new Error('no such lead');
      store[i] = { ...store[i], ...patch };
    },
    async listLeads(businessId) {
      if (failLeads) boom();
      return store.filter(l => l.business_id === businessId);
    },
  };
}

const newLeadRow = (over = {}) => ({
  id: 'lead-1', business_id: BIZ_ID, phone: CUSTOMER, display_name: null,
  status: 'new', source: 'whatsapp',
  first_contact_at: '2026-08-10T08:00:00.000Z', last_contact_at: '2026-08-10T08:00:00.000Z',
  last_direction: 'in', payload: {}, notes: null, status_history: [], ...over,
});

function makeCoexDb({ coexistence = true } = {}) {
  const standdowns = [];
  return {
    standdowns,
    async getBusinessByPhoneNumberId(pnid) { return pnid === PNID ? { id: BIZ_ID } : null; },
    async getCoexistenceSettings() { return { coexistence, coexistence_standdown_minutes: 60 }; },
    async setStanddown(sessionId, businessId, untilIso) { standdowns.push({ sessionId, businessId, untilIso }); },
    async getStanddown() { return null; },
  };
}

test.afterEach(() => {
  coex._setDbForTest(null);
  leads._setDbForTest(null);
  engine._setDbForTest(null);
  trial._setRelayForTest(null);
});

// ── Owner echo → contacted ───────────────────────────────────────────────────

test('owner echo on a coexistence+leads business: lead → contacted AND standdown armed', async () => {
  const coexDb = makeCoexDb();
  const leadsDb = makeFakeLeadsDb({ rows: [newLeadRow()] });
  coex._setDbForTest(coexDb);
  leads._setDbForTest(leadsDb);

  const out = await coex.handleOwnerEcho({ phoneNumberId: PNID, recipient: CUSTOMER });
  assert.equal(out.standdown, true);

  const l = leadsDb.store[0];
  assert.equal(l.status, 'contacted');
  assert.equal(l.last_direction, 'out');
  assert.equal(l.status_history.at(-1).by, 'auto');
  assert.equal(coexDb.standdowns.length, 1);
});

test('owner echo on a NON-coexistence business touches no lead, even with the module on', async () => {
  const leadsDb = makeFakeLeadsDb({ rows: [newLeadRow()] });
  coex._setDbForTest(makeCoexDb({ coexistence: false }));
  leads._setDbForTest(leadsDb);

  const out = await coex.handleOwnerEcho({ phoneNumberId: PNID, recipient: CUSTOMER });
  assert.equal(out.standdown, false);
  assert.equal(leadsDb.store[0].status, 'new'); // untouched
});

test('owner echo with the leads module disabled: standdown still armed, board untouched', async () => {
  const coexDb = makeCoexDb();
  const leadsDb = makeFakeLeadsDb({ enabled: false, rows: [newLeadRow()] });
  coex._setDbForTest(coexDb);
  leads._setDbForTest(leadsDb);

  const out = await coex.handleOwnerEcho({ phoneNumberId: PNID, recipient: CUSTOMER });
  assert.equal(out.standdown, true);
  assert.equal(leadsDb.store[0].status, 'new');
});

test('a broken leads table never costs the owner the standdown', async () => {
  const coexDb = makeCoexDb();
  coex._setDbForTest(coexDb);
  leads._setDbForTest(makeFakeLeadsDb({ failLeads: true }));

  const out = await coex.handleOwnerEcho({ phoneNumberId: PNID, recipient: CUSTOMER });
  assert.equal(out.standdown, true);
  assert.equal(coexDb.standdowns.length, 1);
});

// ── trial_signup success → trial_signed_up + payload merge ───────────────────

const BIZ = { id: BIZ_ID, name: 'קרוספיט קידס — הדרקונים' };
const trialAction = {
  module: 'trial_signup', name: 'submit_trial_request',
  payload: { parent_name: 'שירה לוי', child_name: 'יובל', child_age: '8', preferred_day: 'רביעי' },
};

function armTrialEngine() {
  engine._setDbForTest({
    enabledRows: [{ business_id: BIZ_ID, module_key: 'trial_signup', enabled: true, settings: {}, secrets: {}, status: 'connected' }],
    onEvent: () => {},
  });
  trial._setRelayForTest(async () => ({ holdingLine: 'x' }));
}

test('trial_signup success advances the lead and banks every structured field', async () => {
  armTrialEngine();
  const leadsDb = makeFakeLeadsDb({ rows: [newLeadRow({ status: 'contacted' })] });
  leads._setDbForTest(leadsDb);

  const out = await engine.executeModuleAction(BIZ, trialAction, { session_id: CUSTOMER });
  assert.equal(out.text, CONFIRM);

  const l = leadsDb.store[0];
  assert.equal(l.status, 'trial_signed_up');
  assert.deepEqual(l.payload, {
    parent_name: 'שירה לוי', child_name: 'יובל', child_age: '8', preferred_day: 'רביעי',
  });
  assert.deepEqual(
    { from: l.status_history.at(-1).from, to: l.status_history.at(-1).to, by: l.status_history.at(-1).by },
    { from: 'contacted', to: 'trial_signed_up', by: 'auto' });
});

test('trial_signup keeps the pinned confirmation when the leads table is missing', async () => {
  armTrialEngine();
  leads._setDbForTest(makeFakeLeadsDb({ failLeads: true }));

  const out = await engine.executeModuleAction(BIZ, trialAction, { session_id: CUSTOMER });
  assert.equal(out.text, CONFIRM);
  assert.equal(out.replaceResponse, true);
});

test('trial_signup with the leads module disabled: confirmation flows, board untouched', async () => {
  armTrialEngine();
  const leadsDb = makeFakeLeadsDb({ enabled: false, rows: [newLeadRow()] });
  leads._setDbForTest(leadsDb);

  const out = await engine.executeModuleAction(BIZ, trialAction, { session_id: CUSTOMER });
  assert.equal(out.text, CONFIRM);
  assert.equal(leadsDb.store[0].status, 'new');
  assert.deepEqual(leadsDb.store[0].payload, {});
});

// ── Registry ─────────────────────────────────────────────────────────────────

test('the leads module is catalogued: portal-visible bookkeeping, no model surface', async () => {
  const { MODULES } = await import('../lib/modules/registry.js');
  const def = MODULES.leads;
  assert.equal(def?.key, 'leads');
  assert.equal(def.name, 'ניהול לידים');
  assert.equal(def.portalVisible, true);
  assert.deepEqual(def.actions, {});
  assert.equal(await def.contextProvider(), null); // nothing to tell the model
});
