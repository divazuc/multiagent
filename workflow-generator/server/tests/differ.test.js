const { diffWorkflows } = require('../services/differ')

const base = {
  nodes: [
    { name: 'Webhook', type: 'n8n-nodes-base.webhook' },
    { name: 'Code', type: 'n8n-nodes-base.code' }
  ],
  connections: {
    'Webhook': { main: [[{ node: 'Code', type: 'main', index: 0 }]] }
  }
}

test('detects added node', () => {
  const modified = {
    nodes: [...base.nodes, { name: 'Slack', type: 'n8n-nodes-base.slack' }],
    connections: base.connections
  }
  const diff = diffWorkflows(base, modified)
  expect(diff.added).toContain('Slack')
  expect(diff.removed).toHaveLength(0)
})

test('detects removed node', () => {
  const modified = { nodes: [base.nodes[0]], connections: {} }
  const diff = diffWorkflows(base, modified)
  expect(diff.removed).toContain('Code')
  expect(diff.added).toHaveLength(0)
})

test('detects added connection', () => {
  const modified = {
    nodes: base.nodes,
    connections: {
      ...base.connections,
      'Code': { main: [[{ node: 'Webhook', type: 'main', index: 0 }]] }
    }
  }
  const diff = diffWorkflows(base, modified)
  expect(diff.connectionsAdded.some(c => c.includes('Code'))).toBe(true)
})

test('returns empty diff for identical workflows', () => {
  const diff = diffWorkflows(base, base)
  expect(diff.added).toHaveLength(0)
  expect(diff.removed).toHaveLength(0)
  expect(diff.connectionsAdded).toHaveLength(0)
  expect(diff.connectionsRemoved).toHaveLength(0)
})
