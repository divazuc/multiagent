'use strict'

const { loadGlobalContext } = require('./projectManager')

/**
 * Ask Claude to analyze a project spec and return a proposed workflow map.
 * Returns: { workflows: [{ name, role, purpose, inputs, outputs, calls }], gaps: [] }
 */
async function analyzeSpec(client, spec) {
  const { guidelines, credentialMap } = loadGlobalContext()

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: `You are an n8n workflow system architect. You read project specs and produce a structured workflow map.

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
  "gaps": ["Any missing information needed before generating"]
}

Rules:
- Exactly one workflow must have role "supervisor"
- Sub-workflows always have trigger "sub-workflow"
- The supervisor is the only one triggered externally
- calls[] on supervisor lists all sub-workflow names it will invoke
- calls[] on sub-workflows is always []
- gaps[] lists questions that must be answered before generation can proceed

Global guidelines for this environment:
${guidelines}

Credential map:
${credentialMap}`,
    messages: [
      { role: 'user', content: `Analyze this project spec and return the workflow map:\n\n${spec}` }
    ]
  })

  const text = response.content[0].text
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = match ? match[1].trim() : text.trim()

  try {
    return JSON.parse(candidate)
  } catch {
    throw new Error(`Failed to parse workflow map: ${text.slice(0, 200)}`)
  }
}

/**
 * Generate all workflows for a project in the correct order (subs first, supervisor last).
 */
async function generateProjectWorkflows(client, spec, workflowMap, catalogue) {
  const { getSystemPrompt } = require('../prompts/system')
  const { guidelines, credentialMap } = loadGlobalContext()

  const projectContext = `
## Project Context
${spec}

## Full Workflow Map
${JSON.stringify(workflowMap.workflows, null, 2)}

## Global Guidelines
${guidelines}

## Credential Map
${credentialMap}
`

  const results = []

  // Generate subs first, then supervisor
  const ordered = [
    ...workflowMap.workflows.filter(w => w.role === 'sub'),
    ...workflowMap.workflows.filter(w => w.role === 'supervisor')
  ]

  for (const wfSpec of ordered) {
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

Respond with the standard JSON shape: { "workflow": {...}, "summary": "...", "nodes_used": [...] }`

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: getSystemPrompt(),
      messages: [{ role: 'user', content: prompt }]
    })

    const text = response.content[0].text
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    const candidate = match ? match[1].trim() : text.trim()

    let parsed
    try {
      parsed = JSON.parse(candidate)
    } catch {
      throw new Error(`Failed to parse workflow "${wfSpec.name}": ${text.slice(0, 200)}`)
    }

    results.push({
      spec: wfSpec,
      workflow: parsed.workflow,
      summary: parsed.summary,
      nodes_used: parsed.nodes_used || []
    })
  }

  return results
}

module.exports = { analyzeSpec, generateProjectWorkflows }
