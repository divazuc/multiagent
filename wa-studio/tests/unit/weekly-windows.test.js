import test from 'node:test'
import assert from 'node:assert/strict'
import { addWindow, setWindow, removeWindow, toggleDay } from '../../src/lib/weekly-windows.js'

const MORNING = { from: '09:00', to: '13:00' }
const EVENING = { from: '16:00', to: '19:00' }

test('editing one range leaves the others untouched', () => {
  // The bug this replaces: CalendarSettings did setDay(day, [{...first, from}]),
  // which collapsed a whole day down to a single range on any edit.
  const out = setWindow([MORNING, EVENING], 0, { from: '08:00' })
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], { from: '08:00', to: '13:00' })
  assert.deepEqual(out[1], EVENING)
})

test('adding a range to an empty day opens a sensible default', () => {
  const out = addWindow([])
  assert.equal(out.length, 1)
  assert.equal(out[0].from, '09:00')
  assert.equal(out[0].to, '17:00')
})

test('adding a range to a day that already has one keeps the existing range', () => {
  const out = addWindow([MORNING])
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], MORNING)
})

test('a newly added range starts after the last one ends', () => {
  const out = addWindow([MORNING])
  assert.ok(out[1].from >= MORNING.to, `${out[1].from} should not start before ${MORNING.to}`)
})

test('there is no cap on the number of ranges per day', () => {
  let w = []
  for (let i = 0; i < 4; i++) w = addWindow(w)
  assert.equal(w.length, 4)
})

test('removing a range removes only that one', () => {
  const out = removeWindow([MORNING, EVENING], 0)
  assert.deepEqual(out, [EVENING])
})

test('closing a day clears every range', () => {
  assert.deepEqual(toggleDay([MORNING, EVENING], false), [])
})

test('opening a closed day gives it one range', () => {
  const out = toggleDay([], true)
  assert.equal(out.length, 1)
})

test('opening a day that already has ranges does not duplicate them', () => {
  assert.deepEqual(toggleDay([MORNING], true), [MORNING])
})

test('the helpers never mutate the array they are given', () => {
  const original = [MORNING, EVENING]
  const copy = JSON.parse(JSON.stringify(original))
  setWindow(original, 0, { from: '07:00' })
  addWindow(original)
  removeWindow(original, 1)
  assert.deepEqual(original, copy)
})
