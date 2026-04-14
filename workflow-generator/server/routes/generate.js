'use strict'

const { Router } = require('express')
const Anthropic = require('@anthropic-ai/sdk')
const { generateWorkflow } = require('../services/llm')
const { validateWorkflow } = require('../services/validator')
const catalogue = require('../schema/n8n-nodes-v1.json')

const router = Router()

router.post('/', async (req, res) => {
  const { description } = req.body
  if (!description || typeof description !== 'string' || !description.trim()) {
    return res.status(400).json({ error: 'description is required' })
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  let result
  try {
    result = await generateWorkflow(client, description)
  } catch (err) {
    return res.status(500).json({ error: `LLM error: ${err.message}` })
  }

  let validation = validateWorkflow(result.workflow, catalogue)

  // Auto-retry once with errors fed back to Claude
  if (!validation.valid) {
    const retryDescription = `${description}\n\nYour previous attempt had these validation errors — fix them:\n${validation.errors.join('\n')}`
    try {
      result = await generateWorkflow(client, retryDescription)
      validation = validateWorkflow(result.workflow, catalogue)
    } catch {
      // swallow retry error — return original validation errors
    }
  }

  if (!validation.valid) {
    return res.status(422).json({ errors: validation.errors, partial: result })
  }

  return res.json({
    workflow: result.workflow,
    summary: result.summary,
    nodes_used: result.nodes_used,
    validation
  })
})

module.exports = router
