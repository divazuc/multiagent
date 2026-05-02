jest.mock('@anthropic-ai/sdk')

const Anthropic = require('@anthropic-ai/sdk')
const { generateWorkflow, editWorkflow } = require('../services/llm')

const mockWorkflow = {
  name: 'Test',
  nodes: [{
    id: 'abc-123',
    name: 'Webhook',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position: [100, 200],
    parameters: { path: 'test' }
  }],
  connections: {},
  active: false,
  settings: { executionOrder: 'v1' }
}

const mockLLMResponse = JSON.stringify({
  workflow: mockWorkflow,
  summary: 'Triggers on a webhook',
  nodes_used: ['Webhook']
})

beforeEach(() => {
  Anthropic.mockClear()
  Anthropic.prototype.messages = {
    create: jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: mockLLMResponse }]
    })
  }
})

test('generateWorkflow returns parsed workflow and summary', async () => {
  const client = new Anthropic()
  const result = await generateWorkflow(client, 'trigger on a webhook')
  expect(result.workflow).toEqual(mockWorkflow)
  expect(result.summary).toBe('Triggers on a webhook')
  expect(result.nodes_used).toEqual(['Webhook'])
})

test('generateWorkflow throws on malformed LLM response', async () => {
  Anthropic.prototype.messages = {
    create: jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'not json' }]
    })
  }
  const client = new Anthropic()
  await expect(generateWorkflow(client, 'test')).rejects.toThrow(/parse/i)
})

test('editWorkflow passes existing JSON to LLM', async () => {
  const client = new Anthropic()
  const createSpy = jest.spyOn(Anthropic.prototype.messages, 'create')
  await editWorkflow(client, mockWorkflow, 'add a Slack node')
  const call = createSpy.mock.calls[0][0]
  const userMsg = call.messages[0].content
  expect(userMsg).toContain('add a Slack node')
  expect(userMsg).toContain('"name": "Test"')
})
