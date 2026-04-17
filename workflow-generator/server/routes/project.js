'use strict'

const { Router } = require('express')
const Anthropic = require('@anthropic-ai/sdk')
const { validateWorkflow } = require('../services/validator')
const catalogue = require('../schema/n8n-nodes-v1.json')
const {
  listProjects, saveSpec, loadSpec, loadManifest, saveManifest,
  saveWorkflow, loadWorkflow, loadProjectContext, savePendingInfo,
  loadConversation, appendConversation
} = require('../services/projectManager')
const { analyzeSpec, generateOneWorkflow, buildProjectContext, generateProjectWorkflows, parseJsonResponse } = require('../services/projectAnalyzer')
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

// Return all saved workflow files for a project — used to open workspace
router.get('/:slug/workflows', (req, res) => {
  if (!isValidSlug(req.params.slug)) return res.status(400).json({ error: 'Invalid slug format' })
  const manifest = loadManifest(req.params.slug)
  if (!manifest) return res.status(404).json({ error: 'Project not found' })

  const catalogue = require('../schema/n8n-nodes-v1.json')
  const results = manifest.workflows.map(entry => {
    const workflow = loadWorkflow(req.params.slug, entry.name)
    const validation = workflow ? validateWorkflow(workflow, catalogue) : { valid: false, errors: ['File not found'] }
    return {
      spec: { name: entry.name, role: entry.role, purpose: entry.purpose,
              trigger: entry.trigger, inputs: entry.inputs, outputs: entry.outputs, calls: entry.calls },
      workflow,
      validation,
      summary: entry.summary || '',
      nodes_used: entry.nodes_used || []
    }
  }).filter(r => r.workflow !== null)

  res.json({
    results,
    spec: loadSpec(req.params.slug),
    conversation: loadConversation(req.params.slug),
    manifest
  })
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

// Generate a single workflow — called once per workflow for live progress UI
// Optional `feedback` field appends a change request to the project context
router.post('/generate-one', async (req, res) => {
  const { slug, spec, workflowMap, wfSpec, feedback } = req.body
  if (!slug?.trim()) return res.status(400).json({ error: 'slug is required' })
  if (!isValidSlug(slug)) return res.status(400).json({ error: 'Invalid slug format' })
  if (!spec?.trim()) return res.status(400).json({ error: 'spec is required' })
  if (!workflowMap?.workflows?.length) return res.status(400).json({ error: 'workflowMap is required' })
  if (!wfSpec?.name) return res.status(400).json({ error: 'wfSpec is required' })

  try {
    const client = getAnthropicClient()
    const base = buildProjectContext(spec, workflowMap)
    const projectContext = feedback?.trim()
      ? base + `\n\n## Change Request\n${feedback}\n\nIncorporate this change when generating this workflow.`
      : base
    const item = await generateOneWorkflow(client, wfSpec, projectContext)
    const catalogue = require('../schema/n8n-nodes-v1.json')
    const validation = validateWorkflow(item.workflow, catalogue)
    saveWorkflow(slug, item.spec.name, item.workflow)

    // Upsert manifest entry so progress survives a hard refresh
    const manifest = loadManifest(slug) || {
      slug,
      name: workflowMap.projectName || slug,
      generatedAt: new Date().toISOString(),
      workflows: []
    }
    const entry = {
      name: item.spec.name,
      role: item.spec.role,
      purpose: item.spec.purpose,
      trigger: item.spec.trigger || '',
      inputs: item.spec.inputs || '',
      outputs: item.spec.outputs || '',
      calls: item.spec.calls || [],
      summary: item.summary || '',
      nodes_used: item.nodes_used || [],
      n8nId: null,
      importedAt: null,
      valid: validation.valid,
      validationErrors: validation.errors
    }
    const existingIdx = manifest.workflows.findIndex(w => w.name === item.spec.name)
    if (existingIdx >= 0) manifest.workflows[existingIdx] = entry
    else manifest.workflows.push(entry)
    saveManifest(slug, manifest)

    res.json({ ...item, validation })
  } catch (err) {
    console.error('[project/generate-one]', err.message)
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
        trigger: item.spec.trigger || '',
        inputs: item.spec.inputs || '',
        outputs: item.spec.outputs || '',
        calls: item.spec.calls || [],
        summary: item.summary || '',
        nodes_used: item.nodes_used || [],
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
  try {
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

    // Datetime suffix — only used when creating a new workflow (not updating)
    const now = new Date()
    const pad = n => String(n).padStart(2, '0')
    const nameSuffix = ` (${now.toLocaleString('en-US', { month: 'short', day: 'numeric' })} ${pad(now.getHours())}:${pad(now.getMinutes())})`

    // Build a lookup of existing n8n IDs from the manifest
    const existingIds = Object.fromEntries(
      (manifest.workflows || [])
        .filter(w => w.n8nId)
        .map(w => [w.name, w.n8nId])
    )

    for (const item of ordered) {
      try {
        const existingN8nId = existingIds[item.name]
        let result

        if (existingN8nId) {
          // Workflow was previously imported — update it in place (keep same n8n ID)
          result = await client.updateWorkflow(existingN8nId, { ...item.workflow, name: item.name })
          // n8n Cloud clears activeVersionId on PUT — re-activate all workflows to republish
          await client.activateWorkflow(existingN8nId).catch(e => console.warn('[import] activate failed:', e.message))
          // Sub-workflows don't need to stay active — deactivate after publishing
          if (item.trigger !== 'webhook') {
            await client.deactivateWorkflow(existingN8nId).catch(e => console.warn('[import] deactivate failed:', e.message))
          }
          console.log('[import] updated existing', item.name, '— n8nId:', existingN8nId)
        } else {
          // First-time import — create new workflow with datetime suffix
          result = await client.importWorkflow({ ...item.workflow, name: `${item.name}${nameSuffix}` })
          console.log('[import] created new', item.name, '— n8nId:', result.id)
        }

        const nodesStored = result.nodes?.length ?? 0
        importResults.push({
          name: item.name, role: item.role,
          n8nId: result.id ?? existingN8nId,
          nodesStored, success: true,
          action: existingN8nId ? 'updated' : 'created'
        })
      } catch (err) {
        console.error('[import] workflow failed:', item.name, err.message)
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
  } catch (err) {
    console.error('[import] unhandled error:', err.message, err.stack)
    res.status(500).json({ error: err.message })
  }
})

// Suggest a practical answer for a pending info item using Haiku
router.post('/:slug/suggest-answer', async (req, res) => {
  const { slug } = req.params
  if (!isValidSlug(slug)) return res.status(400).json({ error: 'Invalid slug format' })
  const manifest = loadManifest(slug)
  if (!manifest) return res.status(404).json({ error: 'Project not found' })

  const { item } = req.body
  if (!item?.trim()) return res.status(400).json({ error: 'item is required' })

  const spec = loadSpec(slug)

  try {
    const client = getAnthropicClient()
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `You are helping configure an n8n automation project. Suggest a short, practical answer for this configuration item.

Project: ${manifest.name}
Spec: ${spec.slice(0, 600)}

Item: "${item}"

Rules:
- Be specific and realistic, not vague
- If it involves a choice, recommend the most practical option with brief reasoning
- If multiple options exist, list the top 2-3 briefly
- Do NOT suggest placeholder values for credentials or API keys
- Keep it under 2 sentences
- Return only the suggestion text, no preamble, no quotes`
      }]
    })
    res.json({ suggestion: resp.content[0].text.trim() })
  } catch (err) {
    console.error('[project/suggest-answer]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Identify which workflows are affected by a request + surface blocking questions
// Cheap Haiku call — does NOT generate anything
router.post('/:slug/identify-request', async (req, res) => {
  const { slug } = req.params
  if (!isValidSlug(slug)) return res.status(400).json({ error: 'Invalid slug format' })
  const manifest = loadManifest(slug)
  if (!manifest) return res.status(404).json({ error: 'Project not found' })

  const { request } = req.body
  if (!request?.trim()) return res.status(400).json({ error: 'request is required' })

  try {
    const client = getAnthropicClient()
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You manage an n8n workflow project. Given a change request, do two things:

1. Identify which workflows need updating.
2. Identify ONLY genuine business decisions the user must make — things where the answer changes what the product does (e.g. "should we notify the customer by email or SMS?"). You should handle ALL technical decisions yourself (node types, error handling, data mapping, retry logic, connection patterns, field formats). Do not ask the user about anything technical.

If you can make a reasonable assumption for a business decision, do so and don't ask. Only surface questions where different answers lead to meaningfully different outcomes for the user's business.

Project: ${manifest.name}
Workflows:
${manifest.workflows.map((w, i) => `${i + 1}. "${w.name}" (${w.role}) — ${w.purpose}`).join('\n')}

Change request: "${request}"

Return JSON only — maximum 3 questions, ideally 0:
{
  "workflows": ["exact workflow name 1"],
  "questions": [
    {
      "text": "Plain language business question (no technical jargon)",
      "options": [
        { "label": "Short option name", "description": "One sentence explaining the outcome" },
        { "label": "Short option name", "description": "One sentence explaining the outcome" }
      ],
      "recommendation": 0
    }
  ]
}

If no business decisions are needed, return "questions": [].`
      }]
    })

    let workflows, questions
    try {
      const parsed = parseJsonResponse(resp.content[0].text)
      const validNames = new Set(manifest.workflows.map(w => w.name))
      workflows = (Array.isArray(parsed.workflows) ? parsed.workflows : []).filter(n => validNames.has(n))
      if (workflows.length === 0) workflows = manifest.workflows.map(w => w.name)
      // Normalise questions — support both string (legacy) and structured object format
      questions = (Array.isArray(parsed.questions) ? parsed.questions : [])
        .filter(Boolean)
        .map(q => typeof q === 'string'
          ? { text: q, options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }], recommendation: 0 }
          : q
        )
    } catch {
      workflows = manifest.workflows.map(w => w.name)
      questions = []
    }

    res.json({ workflows, questions })
  } catch (err) {
    console.error('[project/identify-request]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Append an entry to the project conversation log
router.post('/:slug/conversation', (req, res) => {
  const { slug } = req.params
  if (!isValidSlug(slug)) return res.status(400).json({ error: 'Invalid slug format' })
  const manifest = loadManifest(slug)
  if (!manifest) return res.status(404).json({ error: 'Project not found' })

  const { request, updated } = req.body
  if (!request?.trim()) return res.status(400).json({ error: 'request is required' })

  const conversation = appendConversation(slug, {
    at: new Date().toISOString(),
    request,
    updated: Array.isArray(updated) ? updated : []
  })
  res.json({ conversation })
})

// Process a free-form change request — identifies affected workflows, regenerates them, logs to conversation
router.post('/:slug/request', async (req, res) => {
  const { slug } = req.params
  if (!isValidSlug(slug)) return res.status(400).json({ error: 'Invalid slug format' })
  const manifest = loadManifest(slug)
  if (!manifest) return res.status(404).json({ error: 'Project not found' })

  const { request } = req.body
  if (!request?.trim()) return res.status(400).json({ error: 'request is required' })

  try {
    const client = getAnthropicClient()
    const spec = loadSpec(slug)

    // Reconstruct workflowMap from manifest (trigger/inputs/outputs/calls saved there since generate-one)
    const workflowMap = {
      projectName: manifest.name,
      workflows: manifest.workflows.map(w => ({
        name: w.name,
        role: w.role,
        purpose: w.purpose,
        trigger: w.trigger || (w.role === 'sub' ? 'sub-workflow' : 'webhook'),
        inputs: w.inputs || '',
        outputs: w.outputs || '',
        calls: w.calls || []
      }))
    }

    // Step 1: cheap Haiku call to identify which workflows need updating
    const identifyResp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `You manage an n8n workflow project. Based on this change request, which workflows need to be updated?

Project: ${manifest.name}
Workflows:
${manifest.workflows.map((w, i) => `${i + 1}. "${w.name}" (${w.role}) — ${w.purpose}`).join('\n')}

Change request: "${request}"

Return JSON only: { "workflows": ["exact name 1", "exact name 2"] }
If the request is general or unclear which workflows are affected, include all workflow names.`
      }]
    })

    let toUpdate
    try {
      const parsed = parseJsonResponse(identifyResp.content[0].text)
      toUpdate = Array.isArray(parsed.workflows) ? parsed.workflows : manifest.workflows.map(w => w.name)
    } catch {
      toUpdate = manifest.workflows.map(w => w.name)
    }

    // Sanitise: only known names, fall back to all if empty
    const validNames = new Set(manifest.workflows.map(w => w.name))
    toUpdate = toUpdate.filter(n => validNames.has(n))
    if (toUpdate.length === 0) toUpdate = manifest.workflows.map(w => w.name)

    // Step 2: regenerate identified workflows with request as additional context
    const contextWithRequest = buildProjectContext(spec, workflowMap) +
      `\n\n## Change Request from User\n${request}\n\nIncorporate this change when generating this workflow.`

    const ordered = [
      ...workflowMap.workflows.filter(w => w.role === 'sub' && toUpdate.includes(w.name)),
      ...workflowMap.workflows.filter(w => w.role === 'supervisor' && toUpdate.includes(w.name))
    ]

    const results = []
    for (const wfSpec of ordered) {
      const item = await generateOneWorkflow(client, wfSpec, contextWithRequest)
      const validation = validateWorkflow(item.workflow, catalogue)
      saveWorkflow(slug, item.spec.name, item.workflow)

      const existingIdx = manifest.workflows.findIndex(w => w.name === item.spec.name)
      if (existingIdx >= 0) {
        manifest.workflows[existingIdx] = {
          ...manifest.workflows[existingIdx],
          summary: item.summary || '',
          nodes_used: item.nodes_used || [],
          valid: validation.valid,
          validationErrors: validation.errors
        }
      }
      results.push({ ...item, validation })
    }

    saveManifest(slug, manifest)

    const conversation = appendConversation(slug, {
      at: new Date().toISOString(),
      request,
      updated: toUpdate
    })

    res.json({ results, updated: toUpdate, conversation })
  } catch (err) {
    console.error('[project/request]', err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
