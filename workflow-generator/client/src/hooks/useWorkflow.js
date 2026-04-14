export async function apiGenerate(description) {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`)
  return data
}

export async function apiEdit(workflow, changeDescription) {
  const res = await fetch('/api/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflow, changeDescription })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`)
  return data
}

export async function apiListN8nWorkflows(n8nUrl, n8nApiKey) {
  const res = await fetch('/api/n8n/workflows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ n8nUrl, n8nApiKey })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`)
  return data.workflows
}

export async function apiGetN8nWorkflow(n8nUrl, n8nApiKey, id) {
  const res = await fetch(`/api/n8n/workflows/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ n8nUrl, n8nApiKey })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`)
  return data.workflow
}

export async function apiTestWorkflow(n8nUrl, n8nApiKey, workflow) {
  const res = await fetch('/api/n8n/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ n8nUrl, n8nApiKey, workflow })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`)
  return data
}

export async function apiDeleteWorkflow(n8nUrl, n8nApiKey, workflowId) {
  const res = await fetch('/api/n8n/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ n8nUrl, n8nApiKey, workflowId })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`)
  return data
}
