// Editing the bookable-hours ranges of one weekday.
//
// The calendar module stores `weekly[day]` as an ARRAY of {from,to} windows and
// the slot engine iterates all of them (server/lib/modules/calendar/slots.js:51).
// The first editor only ever read w[0] and wrote a single-element array back, so
// a day with a morning and an evening range lost the evening one the moment
// anyone touched it. These helpers keep the whole array intact.

const DEFAULT_FIRST = { from: '09:00', to: '17:00' }
const DEFAULT_NEXT_LENGTH_H = 3

function addHours(hhmm, hours) {
  const [h, m] = hhmm.split(':').map(Number)
  const capped = Math.min(h + hours, 23)
  return `${String(capped).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function setWindow(windows, index, patch) {
  return (windows ?? []).map((w, i) => (i === index ? { ...w, ...patch } : w))
}

export function addWindow(windows) {
  const list = windows ?? []
  if (!list.length) return [{ ...DEFAULT_FIRST }]
  const last = list[list.length - 1]
  const from = last.to
  return [...list, { from, to: addHours(from, DEFAULT_NEXT_LENGTH_H) }]
}

export function removeWindow(windows, index) {
  return (windows ?? []).filter((_, i) => i !== index)
}

export function toggleDay(windows, open) {
  if (!open) return []
  const list = windows ?? []
  return list.length ? list : [{ ...DEFAULT_FIRST }]
}
