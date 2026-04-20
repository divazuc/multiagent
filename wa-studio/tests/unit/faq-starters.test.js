import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ARCHETYPES,
  FAQ_STARTERS_BY_CATEGORY,
  filterStartersForArchetype,
} from '../../src/lib/faq-starters.js'

test('ARCHETYPES exposes studio / service / other labels', () => {
  assert.deepEqual(Object.keys(ARCHETYPES).sort(), ['other', 'service', 'studio'])
  for (const v of Object.values(ARCHETYPES)) assert.equal(typeof v, 'string')
})

test('FAQ_STARTERS_BY_CATEGORY shape — every item has question + archetypes array', () => {
  for (const [cat, items] of Object.entries(FAQ_STARTERS_BY_CATEGORY)) {
    assert.ok(Array.isArray(items), `category ${cat} not an array`)
    for (const item of items) {
      assert.equal(typeof item.question, 'string', `${cat}: question must be string`)
      assert.ok(item.question.length > 0, `${cat}: empty question`)
      assert.ok(Array.isArray(item.archetypes), `${cat}: archetypes must be array`)
      for (const a of item.archetypes) {
        assert.ok(['studio', 'service', 'other'].includes(a), `${cat}: unknown archetype ${a}`)
      }
    }
  }
})

test('filterStartersForArchetype(studio) returns studio + universal items with category preserved', () => {
  const out = filterStartersForArchetype('studio')
  assert.ok(out.length > 0)
  for (const item of out) {
    assert.equal(typeof item.category, 'string')
    assert.equal(typeof item.question, 'string')
    assert.ok(Array.isArray(item.archetypes))
    const isStudio = item.archetypes.includes('studio')
    const isUniversal = item.archetypes.length === 0
    assert.ok(isStudio || isUniversal, `unexpected archetypes for studio: ${JSON.stringify(item)}`)
  }
  assert.ok(!out.some(i => i.archetypes.length === 1 && i.archetypes[0] === 'service'))
})

test('filterStartersForArchetype(service) excludes studio-only items', () => {
  const out = filterStartersForArchetype('service')
  assert.ok(!out.some(i => i.archetypes.length === 1 && i.archetypes[0] === 'studio'))
  assert.ok(out.some(i => i.archetypes.length === 0), 'universal items must appear for service')
})

test('filterStartersForArchetype(other) returns only universal items', () => {
  const out = filterStartersForArchetype('other')
  for (const item of out) {
    assert.equal(item.archetypes.length, 0, `non-universal item leaked to other: ${JSON.stringify(item)}`)
  }
})

test('filterStartersForArchetype(null or unknown) returns only universal items', () => {
  const nullOut = filterStartersForArchetype(null)
  const unknownOut = filterStartersForArchetype('nonsense')
  for (const item of [...nullOut, ...unknownOut]) {
    assert.equal(item.archetypes.length, 0)
  }
})
