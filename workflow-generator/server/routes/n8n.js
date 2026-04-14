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

    let executionResult = null
    try {
      const exec = await client.triggerManualTest(importedId)
      executionResult = exec
    } catch (execErr) {
      return res.json({
        success: false,
        importedId,
        error: `Execution failed: ${execErr.message}`,
        message: 'The workflow was imported but the test execution failed.'
      })
    }

    return res.json({ success: true, importedId, execution: executionResult })
  } catch (err) {
    return res.status(500).json({ error: err.message, importedId })
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
