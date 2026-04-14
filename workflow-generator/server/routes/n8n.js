'use strict'

const { Router } = require('express')
const { createN8nClient } = require('../services/n8nClient')

const router = Router()

function getClient() {
  const { N8N_URL, N8N_API_KEY } = process.env
  if (!N8N_URL || !N8N_API_KEY) {
    throw new Error('N8N_URL and N8N_API_KEY must be set in .env')
  }
  return createN8nClient(N8N_URL, N8N_API_KEY)
}

// List workflows from the configured n8n instance
router.get('/workflows', async (req, res) => {
  try {
    const client = getClient()
    const workflows = await client.listWorkflows()
    return res.json({ workflows: workflows.map(w => ({ id: w.id, name: w.name })) })
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }
})

// Get a single workflow by ID
router.get('/workflows/:id', async (req, res) => {
  try {
    const client = getClient()
    const workflow = await client.getWorkflow(req.params.id)
    return res.json({ workflow })
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }
})

// Safe test run: import as inactive, trigger, return outcome
router.post('/test', async (req, res) => {
  const { workflow } = req.body
  if (!workflow) {
    return res.status(400).json({ error: 'workflow is required' })
  }

  let client
  try {
    client = getClient()
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }

  let importedId = null

  try {
    const imported = await client.importWorkflow(workflow)
    importedId = imported.id

    const n8nBase = process.env.N8N_URL.replace(/\/$/, '')
    const workflowUrl = `${n8nBase}/workflow/${importedId}`

    return res.json({
      success: true,
      importedId,
      workflowUrl,
      message: 'Workflow imported successfully. Open it in n8n to review and run it.'
    })
  } catch (err) {
    return res.status(500).json({ error: err.message, importedId })
  }
})

// Get last execution result for a workflow
router.get('/executions/:workflowId', async (req, res) => {
  try {
    const client = getClient()
    const data = await client.getLastExecution(req.params.workflowId)
    const executions = data.data || []
    if (executions.length === 0) {
      return res.json({ found: false, message: 'No executions yet. Run the workflow in n8n first.' })
    }
    const exec = executions[0]
    return res.json({
      found: true,
      status: exec.status,
      finished: exec.finished,
      startedAt: exec.startedAt,
      stoppedAt: exec.stoppedAt,
      error: exec.data?.resultData?.error?.message || null
    })
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }
})

// Delete a previously imported test workflow
router.post('/delete', async (req, res) => {
  const { workflowId } = req.body
  if (!workflowId) {
    return res.status(400).json({ error: 'workflowId is required' })
  }
  try {
    const client = getClient()
    await client.deleteWorkflow(workflowId)
    return res.json({ deleted: true })
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }
})

module.exports = router
