// wa-studio/tests/unit/save-bot-policy.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { saveBotPolicy } from '../../src/lib/savePolicy.js'

test('the policy update and both contacts are posted in order when everything succeeds', async () => {
  const calls = []
  await saveBotPolicy({
    businessId: 'b1',
    updates: { agent_active: true, nudge_interval_hours: 6 },
    contacts: { owner: { name: 'דיוה' }, rep: { name: 'סאלי' } },
    postUpdate: async (bizId, u) => { calls.push(['update', bizId, u]) },
    postContact: async (bizId, role, fields) => { calls.push(['contact', bizId, role, fields]) },
  })
  assert.deepEqual(calls, [
    ['update', 'b1', { agent_active: true, nudge_interval_hours: 6 }],
    ['contact', 'b1', 'owner', { name: 'דיוה' }],
    ['contact', 'b1', 'rep', { name: 'סאלי' }],
  ])
})

test('a failing nudge/policy update propagates instead of being swallowed — no contact is attempted', async () => {
  let contactAttempted = false
  await assert.rejects(
    () => saveBotPolicy({
      businessId: 'b1',
      updates: { nudge_interval_hours: 6 },
      contacts: { owner: { name: 'דיוה' } },
      postUpdate: async () => { throw new Error('HTTP 500') },
      postContact: async () => { contactAttempted = true },
    }),
    /HTTP 500/,
  )
  assert.equal(contactAttempted, false)
})

test('a failing contact save propagates — the caller must not treat this as a successful save', async () => {
  await assert.rejects(
    () => saveBotPolicy({
      businessId: 'b1',
      updates: {},
      contacts: { rep: { phone: '123' } },
      postUpdate: async () => {},
      postContact: async () => { throw new Error('unusable phone: 123'); },
    }),
    /unusable phone/,
  )
})

test('a failing contact save is tagged with which role failed, so the operator can find it', async () => {
  try {
    await saveBotPolicy({
      businessId: 'b1',
      updates: {},
      contacts: { owner: { name: 'ok' }, rep: { phone: '123' } },
      postUpdate: async () => {},
      postContact: async (bizId, role) => { if (role === 'rep') throw new Error('unusable phone: 123'); },
    })
    assert.fail('expected saveBotPolicy to reject')
  } catch (e) {
    assert.equal(e.role, 'rep')
    assert.match(e.message, /unusable phone/)
  }
})
