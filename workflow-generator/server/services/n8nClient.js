'use strict'

/**
 * Create a client for the n8n REST API.
 * @param {string} baseUrl - e.g. "http://localhost:5678"
 * @param {string} apiKey
 * @returns {object}
 */
function createN8nClient(baseUrl, apiKey) {
  const url = baseUrl.replace(/\/$/, '')

  async function request(path, options = {}) {
    const res = await fetch(`${url}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-N8N-API-KEY': apiKey,
        ...(options.headers || {})
      }
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(`n8n API error ${res.status}: ${body.message || 'unknown error'}`)
    }
    return res.json()
  }

  return {
    listWorkflows() {
      return request('/api/v1/workflows').then(r => r.data || r)
    },

    getWorkflow(id) {
      return request(`/api/v1/workflows/${id}`)
    },

    importWorkflow(workflow) {
      const { active, id, settings, ...rest } = workflow
      return request('/api/v1/workflows', {
        method: 'POST',
        body: JSON.stringify({ ...rest, settings: {} })
      })
    },

    deleteWorkflow(id) {
      return request(`/api/v1/workflows/${id}`, { method: 'DELETE' })
    },

    async triggerManualTest(workflowId) {
      return request(`/api/v1/workflows/${workflowId}/execute`, { method: 'POST', body: '{}' })
    },

    getExecution(executionId) {
      return request(`/api/v1/executions/${executionId}`)
    },

    getLastExecution(workflowId) {
      return request(`/api/v1/executions?workflowId=${workflowId}&limit=1&includeData=false`)
    }
  }
}

module.exports = { createN8nClient }
