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
      throw new Error(`n8n API error ${res.status} ${options.method || 'GET'} ${path}: ${body.message || JSON.stringify(body)}`)
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

    async importWorkflow(workflow) {
      const nodes = workflow.nodes || []
      const connections = workflow.connections || {}
      const settings = { executionOrder: 'v1', ...(workflow.settings || {}) }

      const postBody = { name: workflow.name, nodes, connections, settings }
      console.log('[n8n import] POST', workflow.name, '— sending', nodes.length, 'nodes')

      const created = await request('/api/v1/workflows', {
        method: 'POST',
        body: JSON.stringify(postBody)
      })

      // Log what n8n actually stored so we can detect silent node-stripping
      const storedNodes = created.nodes?.length ?? 0
      console.log('[n8n import] POST done — id:', created.id, '— n8n stored', storedNodes, 'nodes (sent', nodes.length, ')')

      if (storedNodes === 0 && nodes.length > 0) {
        // n8n didn't store nodes via POST — try PUT to push them in
        console.log('[n8n import] PUT to push nodes into', created.id)
        return request(`/api/v1/workflows/${created.id}`, {
          method: 'PUT',
          body: JSON.stringify({ name: workflow.name, nodes, connections, settings })
        })
      }

      return created
    },

    async updateWorkflow(id, workflow) {
      const nodes = workflow.nodes || []
      const connections = workflow.connections || {}
      const settings = { executionOrder: 'v1', ...(workflow.settings || {}) }

      console.log('[n8n update] PUT', workflow.name, '— id:', id, '— sending', nodes.length, 'nodes')

      const updated = await request(`/api/v1/workflows/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: workflow.name, nodes, connections, settings })
      })

      const storedNodes = updated.nodes?.length ?? 0
      console.log('[n8n update] PUT done — n8n stored', storedNodes, 'nodes')
      return updated
    },

    activateWorkflow(id) {
      return request(`/api/v1/workflows/${id}/activate`, { method: 'POST', body: '{}' })
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
