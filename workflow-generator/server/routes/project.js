'use strict'

const { Router } = require('express')
const Anthropic = require('@anthropic-ai/sdk')
const { validateWorkflow } = require('../services/validator')
const catalogue = require('../schema/n8n-nodes-v1.json')
const {
  listProjects, saveSpec, loadManifest, saveManifest,
  saveWorkflow, loadProjectContext, savePendingInfo
} = require('../services/projectManager')
const { analyzeSpec, generateProjectWorkflows } = require('../services/projectAnalyzer')
const { createN8nClient } = require('../services/n8nClient')

const router = Router()

const VALID_SLUG = /^[a-z0-9][a-z0-9-]*$/
function isValidSlug(slug) { return typeof slug === 'string' && VALID_SLUG.test(slug) }

function getAnthropicClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
}

// List all projects
router.get('/', (req, res) => {
  res.json({ projects: listProjects() })
})

// Get a project's manifest and context
router.get('/:slug', (req, res) => {
  if (!isValidSlug(req.params.slug)) return res.status(400).json({ error: 'Invalid slug format' })
  const manifest = loadManifest(req.params.slug)
  if (!manifest) return res.status(404).json({ error: 'Project not found' })
  res.json({ manifest })
})

// Analyze a spec — returns proposed workflow map without generating anything
router.post('/analyze', async (req, res) => {
  const { spec, clarifications } = req.body
  if (!spec?.trim()) return res.status(400).json({ error: 'spec is required' })

  try {
    const client = getAnthropicClient()
    const workflowMap = await analyzeSpec(client, spec, clarifications || '')
    res.json({ workflowMap })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Generate all workflows for a project from spec + approved workflow map
router.post('/generate', async (req, res) => {
  const { slug, spec, workflowMap, pendingInfo } = req.body
  if (!slug?.trim()) return res.status(400).json({ error: 'slug is required' })
  if (!isValidSlug(slug)) return res.status(400).json({ error: 'Invalid slug format — use lowercase letters, numbers, and hyphens only' })
  if (!spec?.trim()) return res.status(400).json({ error: 'spec is required' })
  if (!workflowMap?.workflows?.length) return res.status(400).json({ error: 'workflowMap is required' })

  try {
    const client = getAnthropicClient()
    saveSpec(slug, spec)

    // Save pending info to disk before generating
    if (Array.isArray(pendingInfo) && pendingInfo.length > 0) {
      savePendingInfo(slug, pendingInfo)
    }

    const generated = await generateProjectWorkflows(client, spec, workflowMap, catalogue)

    // Validate each workflow
    const results = generated.map(item => ({
      ...item,
      validation: validateWorkflow(item.workflow, catalogue)
    }))

    // Save workflows to disk
    for (const item of results) {
      saveWorkflow(slug, item.spec.name, item.workflow)
    }

    // Save initial manifest
    const manifest = {
      slug,
      name: workflowMap.projectName || slug,
      generatedAt: new Date().toISOString(),
      workflows: results.map(item => ({
        name: item.spec.name,
        role: item.spec.role,
        purpose: item.spec.purpose,
        n8nId: null,
        importedAt: null,
        valid: item.validation.valid,
        validationErrors: item.validation.errors
      }))
    }
    saveManifest(slug, manifest)

    res.json({ results, manifest })
  } catch (err) {
    console.error('[project/generate]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Save or overwrite a single workflow in a project (upserts manifest entry)
router.post('/:slug/workflows', (req, res) => {
  const { slug } = req.params
  if (!isValidSlug(slug)) return res.status(400).json({ error: 'Invalid slug format' })
  const manifest = loadManifest(slug)
  if (!manifest) return res.status(404).json({ error: 'Project not found' })

  const { name, role, workflow } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' })
  if (!workflow || typeof workflow !== 'object') return res.status(400).json({ error: 'workflow must be a JSON object' })

  saveWorkflow(slug, name, workflow)

  const existing = manifest.workflows.find(w => w.name === name)
  if (existing) {
    existing.savedAt = new Date().toISOString()
  } else {
    manifest.workflows.push({
      name,
      role: role || 'sub',
      purpose: '',
      n8nId: null,
      importedAt: null,
      valid: true,
      validationErrors: [],
      savedAt: new Date().toISOString()
    })
  }
  saveManifest(slug, manifest)

  res.json({ ok: true, manifest })
})

// Import all generated workflows to n8n (subs first, supervisor last)
router.post('/:slug/import', async (req, res) => {
  const { slug } = req.params
  if (!isValidSlug(slug)) return res.status(400).json({ error: 'Invalid slug format' })
  const manifest = loadManifest(slug)
  if (!manifest) return res.status(404).json({ error: 'Project not found. Generate workflows first.' })

  const { workflows } = req.body
  if (!workflows?.length) return res.status(400).json({ error: 'workflows array is required' })

  const { N8N_URL, N8N_API_KEY } = process.env
  if (!N8N_URL || !N8N_API_KEY) return res.status(500).json({ error: 'N8N_URL and N8N_API_KEY must be set in .env' })

  const client = createN8nClient(N8N_URL, N8N_API_KEY)
  const importResults = []

  // Import subs first, then supervisor
  const ordered = [
    ...workflows.filter(w => w.role === 'sub'),
    ...workflows.filter(w => w.role === 'supervisor')
  ]

  for (const item of ordered) {
    try {
      const imported = await client.importWorkflow(item.workflow)
      importResults.push({ name: item.name, role: item.role, n8nId: imported.id, success: true })
    } catch (err) {
      importResults.push({ name: item.name, role: item.role, n8nId: null, success: false, error: err.message })
    }
  }

  // Update manifest with n8n IDs
  const updatedManifest = {
    ...manifest,
    workflows: manifest.workflows.map(wf => {
      const result = importResults.find(r => r.name === wf.name)
      return result
        ? { ...wf, n8nId: result.n8nId, importedAt: new Date().toISOString() }
        : wf
    })
  }
  saveManifest(slug, updatedManifest)

  const n8nBase = N8N_URL.replace(/\/$/, '')
  const resultsWithLinks = importResults.map(r => ({
    ...r,
    workflowUrl: r.n8nId ? `${n8nBase}/workflow/${r.n8nId}` : null
  }))

  res.json({ results: resultsWithLinks, manifest: updatedManifest })
})

module.exports = router
