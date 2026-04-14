'use strict'

const { Router } = require('express')
const { createN8nClient } = require('../services/n8nClient')

const router = Router()

function getClient(req) {
  const { n8nUrl, n8nApiKey } = req.body || req.query
  if (!n8nUrl || !n8nApiKey) throw new Error('n8nUrl and n8nApiKey are required')
  return createN8nClient(n8nUrl, n8nApiKey)
}

// List workflows from a live n8n instance
router.post('/workflows', async (req, res) => {
  try {
    const client = getClient(req)
    const workflows = await client.listWorkflows()
    return res.json({ workflows: workflows.map(w => ({ id: w.id, name: w.name })) })
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }
})

// Get a single workflow by ID
router.post('/workflows/:id', async (req, res) => {
  try {
    const client = getClient(req)
    const workflow = await client.getWorkflow(req.params.id)
    return res.json({ workflow })
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }
})

// Safe test run: import as inactive, trigger, read result, return outcome
router.post('/test', async (req, res) => {
  const { n8nUrl, n8nApiKey, workflow } = req.body
  if (!n8nUrl || !n8nApiKey || !workflow) {
    return res.status(400).json({ error: 'n8nUrl, n8nApiKey, and workflow are required' })
  }

  const client = createN8nClient(n8nUrl, n8nApiKey)
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
  const { n8nUrl, n8nApiKey, workflowId } = req.body
  if (!n8nUrl || !n8nApiKey || !workflowId) {
    return res.status(400).json({ error: 'n8nUrl, n8nApiKey, and workflowId are required' })
  }
  try {
    const client = createN8nClient(n8nUrl, n8nApiKey)
    await client.deleteWorkflow(workflowId)
    return res.json({ deleted: true })
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }
})

module.exports = router
