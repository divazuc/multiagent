const { createN8nClient } = require('../services/n8nClient')

// Mock global fetch
global.fetch = jest.fn()

const client = createN8nClient('http://localhost:5678', 'test-api-key')

const mockWorkflow = { id: 'wf-1', name: 'My Workflow', nodes: [], connections: {} }

beforeEach(() => { fetch.mockClear() })

test('listWorkflows calls correct endpoint with auth header', async () => {
  fetch.mockResolvedValue({
    ok: true,
    json: async () => ({ data: [mockWorkflow] })
  })
  const result = await client.listWorkflows()
  expect(fetch).toHaveBeenCalledWith(
    'http://localhost:5678/api/v1/workflows',
    expect.objectContaining({ headers: expect.objectContaining({ 'X-N8N-API-KEY': 'test-api-key' }) })
  )
  expect(result).toEqual([mockWorkflow])
})

test('getWorkflow fetches single workflow by id', async () => {
  fetch.mockResolvedValue({ ok: true, json: async () => mockWorkflow })
  const result = await client.getWorkflow('wf-1')
  expect(fetch).toHaveBeenCalledWith(
    'http://localhost:5678/api/v1/workflows/wf-1',
    expect.anything()
  )
  expect(result).toEqual(mockWorkflow)
})

test('importWorkflow POSTs workflow as inactive', async () => {
  fetch.mockResolvedValue({ ok: true, json: async () => ({ ...mockWorkflow, id: 'new-wf' }) })
  const result = await client.importWorkflow(mockWorkflow)
  const call = fetch.mock.calls[0]
  const body = JSON.parse(call[1].body)
  expect(body.active).toBe(false)
  expect(result.id).toBe('new-wf')
})

test('deleteWorkflow calls DELETE endpoint', async () => {
  fetch.mockResolvedValue({ ok: true, json: async () => ({}) })
  await client.deleteWorkflow('wf-1')
  expect(fetch).toHaveBeenCalledWith(
    'http://localhost:5678/api/v1/workflows/wf-1',
    expect.objectContaining({ method: 'DELETE' })
  )
})

test('throws on non-ok response', async () => {
  fetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({ message: 'Unauthorized' }) })
  await expect(client.listWorkflows()).rejects.toThrow(/401/)
})
