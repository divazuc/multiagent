'use strict'

const { getSystemPrompt } = require('../prompts/system')

/**
 * Call Claude to generate a new workflow from a natural language description.
 * @param {import('@anthropic-ai/sdk').Anthropic} client
 * @param {string} description
 * @returns {Promise<{ workflow: object, summary: string, nodes_used: string[] }>}
 */
async function generateWorkflow(client, description) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: getSystemPrompt(),
    messages: [
      { role: 'user', content: `Create an n8n workflow that does the following:\n\n${description}` }
    ]
  })
  return parseResponse(response)
}

/**
 * Call Claude to modify an existing workflow based on a change description.
 * @param {import('@anthropic-ai/sdk').Anthropic} client
 * @param {object} existingWorkflow
 * @param {string} changeDescription
 * @returns {Promise<{ workflow: object, summary: string, nodes_used: string[] }>}
 */
async function editWorkflow(client, existingWorkflow, changeDescription) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: getSystemPrompt(),
    messages: [
      {
        role: 'user',
        content: `Here is an existing n8n workflow:\n\n${JSON.stringify(existingWorkflow, null, 2)}\n\nApply this change:\n\n${changeDescription}`
      }
    ]
  })
  return parseResponse(response)
}

/**
 * @param {object} response - Raw Anthropic API response
 * @returns {{ workflow: object, summary: string, nodes_used: string[] }}
 */
function parseResponse(response) {
  const text = response.content[0].text
  let parsed
  try {
    const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
    parsed = JSON.parse(cleaned)
  } catch {
    throw new Error(`Failed to parse LLM response as JSON: ${text.slice(0, 200)}`)
  }
  if (!parsed.workflow || !parsed.summary) {
    throw new Error('LLM response missing required fields: workflow, summary')
  }
  return { workflow: parsed.workflow, summary: parsed.summary, nodes_used: parsed.nodes_used || [] }
}

module.exports = { generateWorkflow, editWorkflow }
