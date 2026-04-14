const { validateWorkflow } = require('../services/validator')
const catalogue = require('../schema/n8n-nodes-v1.json')

const baseNode = (overrides = {}) => ({
  id: 'node-1',
  name: 'Webhook',
  type: 'n8n-nodes-base.webhook',
  typeVersion: 2,
  position: [100, 200],
  parameters: { path: 'test' },
  ...overrides
})

const minimalWorkflow = {
  name: 'Test Workflow',
  nodes: [baseNode()],
  connections: {},
  settings: { executionOrder: 'v1' }
}

test('accepts a valid minimal workflow', () => {
  const result = validateWorkflow(minimalWorkflow, catalogue)
  expect(result.valid).toBe(true)
  expect(result.errors).toHaveLength(0)
})

test('rejects node missing required base field', () => {
  const wf = {
    ...minimalWorkflow,
    nodes: [baseNode({ id: undefined })]
  }
  const result = validateWorkflow(wf, catalogue)
  expect(result.valid).toBe(false)
  expect(result.errors[0]).toMatch(/id/)
})

test('rejects unknown node type', () => {
  const wf = {
    ...minimalWorkflow,
    nodes: [baseNode({ type: 'n8n-nodes-base.doesNotExist' })]
  }
  const result = validateWorkflow(wf, catalogue)
  expect(result.valid).toBe(false)
  expect(result.errors[0]).toMatch(/unknown node type/i)
})

test('rejects connection referencing non-existent node', () => {
  const wf = {
    ...minimalWorkflow,
    connections: {
      'Webhook': { main: [[{ node: 'Ghost Node', type: 'main', index: 0 }]] }
    }
  }
  const result = validateWorkflow(wf, catalogue)
  expect(result.valid).toBe(false)
  expect(result.errors[0]).toMatch(/Ghost Node/)
})

test('rejects workflow with no trigger node', () => {
  const wf = {
    ...minimalWorkflow,
    nodes: [baseNode({ type: 'n8n-nodes-base.code', parameters: {} })]
  }
  const result = validateWorkflow(wf, catalogue)
  expect(result.valid).toBe(false)
  expect(result.errors[0]).toMatch(/trigger/i)
})

test('rejects orphaned non-trigger node', () => {
  const wf = {
    name: 'Test',
    nodes: [
      baseNode({ id: 'n1', name: 'Webhook' }),
      { id: 'n2', name: 'Orphan', type: 'n8n-nodes-base.code', typeVersion: 2, position: [300, 200], parameters: {} }
    ],
    connections: {},
    settings: { executionOrder: 'v1' }
  }
  const result = validateWorkflow(wf, catalogue)
  expect(result.valid).toBe(false)
  expect(result.errors[0]).toMatch(/Orphan/)
})
