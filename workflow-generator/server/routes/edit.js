'use strict'

const { Router } = require('express')
const Anthropic = require('@anthropic-ai/sdk')
const { editWorkflow } = require('../services/llm')
const { validateWorkflow } = require('../services/validator')
const { diffWorkflows } = require('../services/differ')
const catalogue = require('../schema/n8n-nodes-v1.json')

const router = Router()

router.post('/', async (req, res) => {
  const { workflow: existingWorkflow, changeDescription } = req.body

  if (!existingWorkflow || typeof existingWorkflow !== 'object') {
    return res.status(400).json({ error: 'workflow is required and must be a JSON object' })
  }
  if (!changeDescription || typeof changeDescription !== 'string' || !changeDescription.trim()) {
    return res.status(400).json({ error: 'changeDescription is required' })
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  let result
  try {
    result = await editWorkflow(client, existingWorkflow, changeDescription)
  } catch (err) {
    return res.status(500).json({ error: `LLM error: ${err.message}` })
  }

  let validation = validateWorkflow(result.workflow, catalogue)

  if (!validation.valid) {
    const retryDesc = `${changeDescription}\n\nYour previous attempt had these validation errors — fix them:\n${validation.errors.join('\n')}`
    try {
      result = await editWorkflow(client, existingWorkflow, retryDesc)
      validation = validateWorkflow(result.workflow, catalogue)
    } catch { /* swallow */ }
  }

  if (!validation.valid) {
    return res.status(422).json({ errors: validation.errors, partial: result })
  }

  const diff = diffWorkflows(existingWorkflow, result.workflow)

  return res.json({
    workflow: result.workflow,
    summary: result.summary,
    nodes_used: result.nodes_used,
    validation,
    diff
  })
})

module.exports = router
