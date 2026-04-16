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

export async function apiAnalyzeSpec(spec, clarifications) {
  const res = await fetch('/api/projects/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spec, clarifications: clarifications || '' })
  })
  const text = await res.text()
  if (!text) throw new Error(`Server returned empty response (status ${res.status}) — is the server running on port 3001?`)
  let data
  try { data = JSON.parse(text) } catch { throw new Error(`Server returned non-JSON: ${text.slice(0, 200)}`) }
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`)
  return data.workflowMap
}

export async function apiGenerateProject(slug, spec, workflowMap, pendingInfo) {
  const res = await fetch('/api/projects/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, spec, workflowMap, pendingInfo: pendingInfo || [] })
  })
  const text = await res.text()
  if (!text) throw new Error(`Server returned empty response (status ${res.status}) — generation may have timed out. Check the server console for details.`)
  let data
  try { data = JSON.parse(text) } catch { throw new Error(`Server returned non-JSON: ${text.slice(0, 300)}`) }
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`)
  return data
}

export async function apiGetProjectWorkflows(slug) {
  const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/workflows`)
  const text = await res.text()
  if (!text) throw new Error('Empty response from server')
  let data
  try { data = JSON.parse(text) } catch { throw new Error(`Non-JSON response: ${text.slice(0, 200)}`) }
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`)
  return data
}

export async function apiGenerateOne(slug, spec, workflowMap, wfSpec, feedback) {
  const res = await fetch('/api/projects/generate-one', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, spec, workflowMap, wfSpec, ...(feedback ? { feedback } : {}) })
  })
  const text = await res.text()
  if (!text) throw new Error(`Server returned empty response (status ${res.status})`)
  let data
  try { data = JSON.parse(text) } catch { throw new Error(`Server returned non-JSON: ${text.slice(0, 300)}`) }
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`)
  return data
}

export async function apiSaveProjectWorkflow(slug, name, role, workflow) {
  const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, role, workflow })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`)
  return data
}

export async function apiSuggestAnswer(slug, item) {
  const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/suggest-answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`)
  return data.suggestion
}

export async function apiIdentifyRequest(slug, request) {
  const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/identify-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`)
  return data  // { workflows: [...names], questions: [...] }
}

export async function apiLogConversation(slug, request, updated) {
  const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/conversation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request, updated })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`)
  return data
}

export async function apiProjectRequest(slug, request) {
  const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request })
  })
  const text = await res.text()
  if (!text) throw new Error(`Server returned empty response (status ${res.status})`)
  let data
  try { data = JSON.parse(text) } catch { throw new Error(`Server returned non-JSON: ${text.slice(0, 300)}`) }
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
