// Client-side mirror of server/lib/domain-classify.js — keep the two in sync.
// bots config: [{id, name, icon, color, panel, keywords}] where keywords is a
// regex source string; the single bot with keywords == null is the default.

export function buildBotTests(bots) {
  if (!Array.isArray(bots)) return null
  const tests = []
  for (const b of bots) {
    if (!b?.id || !b.keywords) continue
    try { tests.push({ id: b.id, re: new RegExp(b.keywords, 'i') }) } catch { /* skip bad pattern */ }
  }
  return tests.length ? tests : null
}

export function defaultBotId(bots) {
  if (!Array.isArray(bots) || !bots.length) return null
  return (bots.find(b => b && b.keywords == null) ?? bots[0]).id ?? null
}

export function classifyText(text, bots) {
  const tests = buildBotTests(bots)
  if (!tests) return null
  const hit = tests.find(t => t.re.test(text ?? ''))
  return hit ? hit.id : defaultBotId(bots)
}

export function botById(bots, id) {
  return (bots ?? []).find(b => b?.id === id) ?? null
}

// A lead belongs to exactly one bot (sessions partition the hub).
export function leadBot(lead, bots) {
  return classifyText(`${lead?.ai_summary || ''} ${lead?.notes || ''}`, bots)
}

// FAQ items differ: an item that matches no keyworded bot is shared —
// location/hours/payment answers belong in every zone.
export function itemBot(item, bots) {
  const tests = buildBotTests(bots)
  if (!tests) return null
  const hit = tests.find(t => t.re.test(`${item?.question || ''} ${item?.answer || ''}`))
  return hit ? hit.id : 'shared'
}
