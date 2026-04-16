'use strict'

const crypto = require('crypto')
const { loadGlobalContext } = require('./projectManager')

/**
 * Post-process a generated workflow to fill in fields Claude was told to omit.
 * Adds id (UUID), typeVersion (1), and position (linear layout) to every node
 * that is missing them, keeping any values Claude did provide.
 */
function enrichWorkflow(workflow) {
  if (!workflow?.nodes?.length) return workflow
  const nodes = workflow.nodes.map((node, i) => ({
    id: node.id || crypto.randomUUID(),
    typeVersion: node.typeVersion ?? 1,
    position: node.position || [100 + i * 300, 200],
    ...node,
  }))
  return { ...workflow, nodes }
}

function parseJsonResponse(text) {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = match ? match[1].trim() : text.trim()
  return JSON.parse(candidate) // throws if invalid or truncated
}

/**
 * Two-pass generation for large workflows that exceed single-call token limits.
 * Pass 1: skeleton (node names + types + connections)
 * Pass 2: parameters for each node individually
 */
async function generateWorkflowTwoPass(client, wfSpec, projectContext, systemPrompt) {
  // Pass 1 — skeleton only
  const skeletonResp = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `Design the node structure for this n8n workflow. Return ONLY node names, types, and connections — no parameters.

${projectContext}

Workflow:
Name: ${wfSpec.name}
Role: ${wfSpec.role}
Purpose: ${wfSpec.purpose}
Trigger: ${wfSpec.trigger}
Inputs: ${wfSpec.inputs}
Outputs: ${wfSpec.outputs}
${wfSpec.calls?.length ? `Calls sub-workflows: ${wfSpec.calls.join(', ')}` : ''}

Respond with JSON only:
{
  "nodes": [{ "name": "...", "type": "n8n-nodes-base.xxx" }],
  "connections": { ... }
}`
    }]
  })

  const skeleton = parseJsonResponse(skeletonResp.content[0].text)

  // Pass 2 — parameters per node (sequential to stay within rate limits)
  const paramResults = []
  for (const node of skeleton.nodes) {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `Generate the parameters object for one n8n node.

Workflow: ${wfSpec.name} — ${wfSpec.purpose}
Node name: "${node.name}"
Node type: ${node.type}

Project context:
${projectContext}

Rules:
- Credential fields: { "id": "CREDENTIAL_ID", "name": "Your Credential Name" }
- HTTP Request nodes calling Anthropic API: use model "claude-sonnet-4-6"
- Sub-workflow IDs: use placeholder "REPLACE_WITH_N8N_ID"

Respond with JSON only: { "parameters": { ... } }`
      }]
    })
    try {
      const data = parseJsonResponse(resp.content[0].text)
      paramResults.push({ name: node.name, parameters: data.parameters || {} })
    } catch {
      paramResults.push({ name: node.name, parameters: {} })
    }
  }

  const paramMap = Object.fromEntries(paramResults.map(r => [r.name, r.parameters]))

  const assembledWorkflow = {
    name: wfSpec.name,
    nodes: skeleton.nodes.map(node => ({ ...node, parameters: paramMap[node.name] || {} })),
    connections: skeleton.connections,
    active: false,
    settings: { executionOrder: 'v1' }
  }

  return {
    workflow: assembledWorkflow,
    summary: wfSpec.purpose,
    nodes_used: skeleton.nodes.map(n => n.name)
  }
}

/**
 * Ask Claude to analyze a project spec and return a proposed workflow map.
 * Returns: {
 *   projectName, workflows,
 *   gaps: [{ question: string, blocking: boolean }],
 *   pendingInfo: string[]
 * }
 */
async function analyzeSpec(client, spec, clarifications) {
  const { guidelines, credentialMap } = loadGlobalContext()

  const userMessage = clarifications?.trim()
    ? `Analyze this project spec and return the workflow map:\n\n${spec}\n\n---\nAdditional clarifications from the user:\n${clarifications}`
    : `Analyze this project spec and return the workflow map:\n\n${spec}`

  const systemPrompt = `You are an n8n workflow system architect. You read project specs and produce a structured workflow map.

CRITICAL: You MUST always respond with a valid JSON object — even when the spec is vague, incomplete, or unclear. Never respond with conversational text or questions. All clarifying questions MUST go inside the gaps[] array as structured objects.

Always respond with a JSON object in this exact shape:
{
  "projectName": "slug-format-name",
  "workflows": [
    {
      "name": "Human readable workflow name",
      "role": "supervisor|sub",
      "purpose": "One sentence — what this workflow does",
      "trigger": "webhook|schedule|manual|sub-workflow",
      "inputs": "What data this workflow receives",
      "outputs": "What data this workflow returns",
      "calls": ["Name of sub-workflow it calls"]
    }
  ],
  "gaps": [
    { "question": "Missing information needed", "blocking": true|false }
  ],
  "pendingInfo": []
}

Gap classification rules:
- blocking: true → the workflow structure CANNOT be correctly determined without this answer (e.g., unknown trigger type, unclear which workflows are needed, ambiguous supervisor/sub relationship)
- blocking: false → generation can proceed with a reasonable placeholder (e.g., email provider choice, specific field names, optional third-party service)
- When the spec is vague, make your best guess at the workflow structure and surface all unknowns as blocking gaps — do not refuse to produce JSON

If the user's clarification text contains deferral signals for a gap (phrases like "will provide later", "don't have this", "not sure yet", "TBD", "decide later", or similar), move that deferred item into pendingInfo[] as a descriptive string instead of keeping it in gaps[]. pendingInfo[] items are human-readable reminders of what is still needed.

Rules:
- Exactly one workflow must have role "supervisor"
- Sub-workflows always have trigger "sub-workflow"
- The supervisor is the only one triggered externally
- calls[] on supervisor lists all sub-workflow names it will invoke
- calls[] on sub-workflows is always []
- gaps[] lists questions about the spec; blocking gaps must be resolved, non-blocking gaps can use placeholders

Global guidelines for this environment:
${guidelines}

Credential map:
${credentialMap}`

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }]
  })

  let text = response.content[0].text
  let match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  let candidate = match ? match[1].trim() : text.trim()

  let parsed
  try {
    parsed = JSON.parse(candidate)
  } catch {
    // Claude returned conversational text — retry with explicit correction
    const retryResponse = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userMessage },
        { role: 'assistant', content: text },
        { role: 'user', content: 'Your response was not valid JSON. You must respond with only the JSON object — no prose, no markdown explanation. Put all your questions in the gaps[] array. Return the JSON now.' }
      ]
    })
    text = retryResponse.content[0].text
    match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    candidate = match ? match[1].trim() : text.trim()
    try {
      parsed = JSON.parse(candidate)
    } catch {
      throw new Error(`Failed to parse workflow map after retry. Claude responded: ${text.slice(0, 300)}`)
    }
  }

  // Normalise: gaps may be strings (legacy) or objects. Ensure object shape.
  if (Array.isArray(parsed.gaps)) {
    parsed.gaps = parsed.gaps
      .map(g =>
        typeof g === 'string' ? { question: g, blocking: true }
        : (g && typeof g === 'object') ? g
        : { question: String(g), blocking: true }
      )
      .map(g => ({ ...g, blocking: g.blocking !== false }))
  } else {
    parsed.gaps = []
  }

  parsed.pendingInfo = (Array.isArray(parsed.pendingInfo) ? parsed.pendingInfo : [])
    .filter(i => i != null)
    .map(i => typeof i === 'string' ? i : String(i))

  return parsed
}

/**
 * Build the shared project context string used by all generation calls.
 */
function buildProjectContext(spec, workflowMap) {
  const { guidelines, credentialMap } = loadGlobalContext()
  return `
## Project Context
${spec}

## Full Workflow Map
${JSON.stringify(workflowMap.workflows, null, 2)}

## Global Guidelines
${guidelines}

## Credential Map
${credentialMap}
`
}

/**
 * Generate a single workflow. Uses single-pass first; falls back to two-pass
 * only on JSON parse failures (truncated response). API errors propagate as-is.
 */
async function generateOneWorkflow(client, wfSpec, projectContext) {
  const { getSystemPrompt } = require('../prompts/system')
  const systemPrompt = getSystemPrompt()

  const prompt = `You are generating ONE workflow in a multi-workflow project. Generate only this workflow — do not generate the others.

${projectContext}

## Workflow to generate now
Name: ${wfSpec.name}
Role: ${wfSpec.role}
Purpose: ${wfSpec.purpose}
Trigger: ${wfSpec.trigger}
Inputs: ${wfSpec.inputs}
Outputs: ${wfSpec.outputs}
${wfSpec.calls?.length ? `Calls these sub-workflows (use Execute Sub-workflow nodes): ${wfSpec.calls.join(', ')}` : ''}

Important: Sub-workflows called via Execute Sub-workflow nodes should use workflowId placeholder "REPLACE_WITH_N8N_ID" — the user will update these after import.

To keep your response compact, omit these fields from every node — the server will add them automatically:
- "id" (UUIDs are generated server-side)
- "position" (layout is calculated server-side)
- "typeVersion" (defaults to 1 unless you need a specific version)

Respond with the standard JSON shape: { "workflow": {...}, "summary": "...", "nodes_used": [...] }`

  let parsed
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }]
    })
    parsed = parseJsonResponse(response.content[0].text)
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.log(`[generate] Single-pass truncated for "${wfSpec.name}" — switching to two-pass`)
      parsed = await generateWorkflowTwoPass(client, wfSpec, projectContext, systemPrompt)
    } else {
      throw err
    }
  }

  return {
    spec: wfSpec,
    workflow: enrichWorkflow(parsed.workflow),
    summary: parsed.summary,
    nodes_used: parsed.nodes_used || []
  }
}

/**
 * Generate all workflows for a project in the correct order (subs first, supervisor last).
 */
async function generateProjectWorkflows(client, spec, workflowMap, catalogue) {
  const projectContext = buildProjectContext(spec, workflowMap)
  const ordered = [
    ...workflowMap.workflows.filter(w => w.role === 'sub'),
    ...workflowMap.workflows.filter(w => w.role === 'supervisor')
  ]
  const results = []
  for (const wfSpec of ordered) {
    results.push(await generateOneWorkflow(client, wfSpec, projectContext))
  }
  return results
}

module.exports = { analyzeSpec, generateOneWorkflow, buildProjectContext, generateProjectWorkflows, parseJsonResponse }
