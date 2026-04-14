'use strict'

/**
 * Compare two n8n workflow objects and return a human-readable diff.
 * @param {object} before
 * @param {object} after
 * @returns {{ added: string[], removed: string[], connectionsAdded: string[], connectionsRemoved: string[] }}
 */
function diffWorkflows(before, after) {
  const beforeNames = new Set((before.nodes || []).map(n => n.name))
  const afterNames = new Set((after.nodes || []).map(n => n.name))

  const added = [...afterNames].filter(n => !beforeNames.has(n))
  const removed = [...beforeNames].filter(n => !afterNames.has(n))

  const beforeConns = flattenConnections(before.connections || {})
  const afterConns = flattenConnections(after.connections || {})

  const connectionsAdded = afterConns.filter(c => !beforeConns.includes(c))
  const connectionsRemoved = beforeConns.filter(c => !afterConns.includes(c))

  return { added, removed, connectionsAdded, connectionsRemoved }
}

/**
 * Flatten connections object into readable strings like "Webhook → Code"
 */
function flattenConnections(connections) {
  const result = []
  for (const [source, outputs] of Object.entries(connections)) {
    const targets = Object.values(outputs).flat(2)
      .filter(Boolean).map(c => c.node).filter(Boolean)
    for (const target of targets) {
      result.push(`${source} → ${target}`)
    }
  }
  return result
}

module.exports = { diffWorkflows }
