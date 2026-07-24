import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.MODULE_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
const { z } = await import('zod');
const { _setModuleForTest } = await import('../lib/modules/registry.js');
const engine = await import('../lib/modules/engine.js');

const events = [];
const errors = [];
engine._setDbForTest({
  enabledRows: [{ business_id: 'b1', module_key: 'fake', enabled: true, settings: {}, secrets: {}, status: 'connected' }],
  onEvent: (e) => events.push(e),
  onMarkError: (e) => errors.push(e),
});

function fakeDef(overrides = {}) {
  return {
    key: 'fake', name: 'Fake',
    settingsSchema: z.object({}).passthrough(), defaultSettings: {},
    contextProvider: async (biz) => `CTX for ${biz.name}`,
    actions: {
      ping: {
        schema: z.object({ msg: z.string() }),
        handler: async (_biz, _row, payload) => ({ confirmationText: `pong:${payload.msg}` }),
      },
    },
    adminUI: { fields: [] },
    ...overrides,
  };
}
_setModuleForTest('fake', fakeDef());

const BIZ = { id: 'b1', name: 'עסק' };

test('buildModulesContext concatenates provider output', async () => {
  const ctx = await engine.buildModulesContext(BIZ);
  assert.ok(ctx.includes('CTX for עסק'));
});

test('executeModuleAction runs a valid action and logs', async () => {
  const r = await engine.executeModuleAction(BIZ, { module: 'fake', name: 'ping', payload: { msg: 'hi' } }, {});
  assert.equal(r.text, 'pong:hi');
  assert.ok(events.some(e => e.event_type === 'action.ping'));
});

test('invalid payload → no execution, failure logged, null text', async () => {
  const r = await engine.executeModuleAction(BIZ, { module: 'fake', name: 'ping', payload: { msg: 5 } }, {});
  assert.equal(r.text, null);
  assert.ok(events.some(e => e.event_type === 'action.ping_failed'));
});

test('unknown module/action → null, never throws', async () => {
  const r1 = await engine.executeModuleAction(BIZ, { module: 'nope', name: 'x', payload: {} }, {});
  const r2 = await engine.executeModuleAction(BIZ, { module: 'fake', name: 'nope', payload: {} }, {});
  assert.equal(r1.text, null); assert.equal(r2.text, null);
});

test('provider throw → context skipped, context_error logged', async () => {
  _setModuleForTest('fake', fakeDef({ contextProvider: async () => { throw new Error('boom'); } }));
  const ctx = await engine.buildModulesContext(BIZ);
  assert.equal(ctx, null);
  assert.ok(events.some(e => e.event_type === 'context_error'));
});

test('TOKEN_ERROR flips module status to error', async () => {
  _setModuleForTest('fake', fakeDef({ contextProvider: async () => { const e = new Error('bad token'); e.code = 'TOKEN_ERROR'; throw e; } }));
  await engine.buildModulesContext(BIZ);
  assert.ok(errors.some(e => e.moduleKey === 'fake'));
});
