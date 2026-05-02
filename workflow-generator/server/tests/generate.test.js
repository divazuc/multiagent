jest.mock('@anthropic-ai/sdk')
jest.mock('../services/llm')

const request = require('supertest')
const express = require('express')
const generateRouter = require('../routes/generate')
const { generateWorkflow } = require('../services/llm')

const app = express()
app.use(express.json())
app.use('/api/generate', generateRouter)

beforeEach(() => { generateWorkflow.mockClear() })

const validWorkflow = {
  name: 'Test',
  nodes: [{
    id: 'abc-123', name: 'Webhook', type: 'n8n-nodes-base.webhook',
    typeVersion: 2, position: [100, 200], parameters: { path: 'test' }
  }],
  connections: {},
  active: false,
  settings: { executionOrder: 'v1' }
}

test('POST /api/generate returns workflow and summary', async () => {
  generateWorkflow.mockResolvedValue({ workflow: validWorkflow, summary: 'Webhook workflow', nodes_used: ['Webhook'] })
  const res = await request(app).post('/api/generate').send({ description: 'trigger on webhook' })
  expect(res.status).toBe(200)
  expect(res.body.workflow).toEqual(validWorkflow)
  expect(res.body.summary).toBe('Webhook workflow')
  expect(res.body.validation.valid).toBe(true)
})

test('POST /api/generate returns 400 when description missing', async () => {
  const res = await request(app).post('/api/generate').send({})
  expect(res.status).toBe(400)
  expect(res.body.error).toMatch(/description/i)
})

test('POST /api/generate retries once and returns errors on persistent validation failure', async () => {
  const badWorkflow = { name: 'Bad', nodes: [{ id: '1', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [0,0], parameters: {} }], connections: {}, active: false, settings: {} }
  generateWorkflow.mockResolvedValue({ workflow: badWorkflow, summary: 'bad', nodes_used: [] })
  const res = await request(app).post('/api/generate').send({ description: 'no trigger workflow' })
  expect(generateWorkflow).toHaveBeenCalledTimes(2)
  expect(res.status).toBe(422)
  expect(res.body.errors).toBeDefined()
})
