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
  if (!res.ok) {
    if (res.status === 422 && data.errors) {
      throw new Error('Validation failed after 2 attempts:\n• ' + data.errors.join('\n• '))
    }
    throw new Error(data.error || `Server error ${res.status}`)
  }
  return data
}

export async function apiListN8nWorkflows() {
  const res = await fetch('/api/n8n/workflows')
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`)
  return data.workflows
}

export async function apiGetN8nWorkflow(id) {
  const res = await fetch(`/api/n8n/workflows/${id}`)
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`)
  return data.workflow
}

export async function apiTestWorkflow(workflow) {
  const res = await fetch('/api/n8n/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflow })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`)
  return data
}

// ── Project API ──────────────────────────────────────────────

export async function apiListProjects() {
  const res = await fetch('/api/projects')
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`)
  return data.projects
}

export async function apiAnalyzeSpec(spec) {
  const res = await fetch('/api/projects/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spec })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`)
  return data.workflowMap
}

export async function apiGenerateProject(slug, spec, workflowMap) {
  const res = await fetch('/api/projects/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, spec, workflowMap })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`)
  return data
}

export async function apiImportProject(slug, workflows) {
  const res = await fetch(`/api/projects/${slug}/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflows })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`)
  return data
}

// ── Execution API ─────────────────────────────────────────────

export async function apiGetLastExecution(workflowId) {
  const res = await fetch(`/api/n8n/executions/${workflowId}`)
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`)
  return data
}

export async function apiDeleteWorkflow(workflowId) {
  const res = await fetch('/api/n8n/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflowId })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`)
  return data
}
