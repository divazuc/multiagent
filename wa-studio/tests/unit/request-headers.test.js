import test from 'node:test'
import assert from 'node:assert/strict'
import { buildHeaders } from '../../src/lib/request-headers.js'

test('a string URL with no init headers yields empty headers instead of throwing', () => {
  // The original code did `init.headers ?? (typeof input === 'object' && input?.headers) ?? undefined`.
  // For a string URL the middle term evaluates to the BOOLEAN false, and `??` does
  // not skip false — so `new Headers(false)` threw and every header-less GET to the
  // agent server failed.
  const h = buildHeaders('https://wagent.divdev.co/business/list', {})
  assert.equal(h.get('Authorization'), null)
})

test('init headers are preserved', () => {
  const h = buildHeaders('https://wagent.divdev.co/studio/rpc', {
    headers: { 'Content-Type': 'application/json' },
  })
  assert.equal(h.get('Content-Type'), 'application/json')
})

test('headers on a Request-like input are used when init has none', () => {
  const h = buildHeaders({ url: 'https://wagent.divdev.co/x', headers: { 'X-Test': 'from-input' } }, {})
  assert.equal(h.get('X-Test'), 'from-input')
})

test('init headers win over headers on the input object', () => {
  const h = buildHeaders(
    { url: 'https://wagent.divdev.co/x', headers: { 'X-Test': 'from-input' } },
    { headers: { 'X-Test': 'from-init' } },
  )
  assert.equal(h.get('X-Test'), 'from-init')
})

test('a null input does not throw', () => {
  const h = buildHeaders(null, {})
  assert.equal(h.get('Authorization'), null)
})

test('an omitted init does not throw', () => {
  const h = buildHeaders('https://wagent.divdev.co/health')
  assert.equal(h.get('Authorization'), null)
})
