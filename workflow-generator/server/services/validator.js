'use strict'

const REQUIRED_NODE_FIELDS = ['id', 'name', 'type', 'typeVersion', 'position', 'parameters']

/**
 * Validate an n8n workflow JSON against the node catalogue.
 * @param {object} workflow - Parsed n8n workflow JSON
 * @param {object} catalogue - n8n-nodes-v1.json contents
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateWorkflow(workflow, catalogue) {
  const errors = []
  const nodes = workflow.nodes || []
  const connections = workflow.connections || {}
  const nodeNames = new Set(nodes.map(n => n.name))

  // Rule 1: required base fields
  for (const node of nodes) {
    for (const field of REQUIRED_NODE_FIELDS) {
      if (node[field] === undefined || node[field] === null) {
        errors.push(`Node "${node.name || node.id || '?'}": missing required field "${field}"`)
      }
    }
  }

  // Rule 2: known node type
  for (const node of nodes) {
    if (node.type && !catalogue.nodes[node.type]) {
      errors.push(`Node "${node.name}": unknown node type "${node.type}"`)
    }
  }

  // Rule 3: connection references exist
  for (const [sourceName, outputs] of Object.entries(connections)) {
    const allOutputs = Object.values(outputs).flat(2)
    for (const conn of allOutputs) {
      if (conn && conn.node && !nodeNames.has(conn.node)) {
        errors.push(`Connection from "${sourceName}" references non-existent node "${conn.node}"`)
      }
    }
  }

  // Rule 4: at least one trigger
  const triggerTypes = new Set(
    Object.entries(catalogue.nodes)
      .filter(([, def]) => def.isTrigger)
      .map(([type]) => type)
  )
  const hasTrigger = nodes.some(n => triggerTypes.has(n.type))
  if (!hasTrigger) {
    errors.push('Workflow has no trigger node. Add a Webhook, Schedule Trigger, or similar.')
  }

  // Rule 5: no orphaned non-trigger nodes
  if (hasTrigger) {
    const reachable = new Set()
    for (const node of nodes) {
      if (triggerTypes.has(node.type)) reachable.add(node.name)
    }
    let changed = true
    while (changed) {
      changed = false
      for (const [source, outputs] of Object.entries(connections)) {
        if (reachable.has(source)) {
          const targets = Object.values(outputs).flat(2)
            .filter(Boolean).map(c => c.node).filter(Boolean)
          for (const t of targets) {
            if (!reachable.has(t)) { reachable.add(t); changed = true }
          }
        }
      }
    }
    for (const node of nodes) {
      if (!triggerTypes.has(node.type) && !reachable.has(node.name)) {
        errors.push(`Node "${node.name}" is orphaned (not reachable from any trigger)`)
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

module.exports = { validateWorkflow }
