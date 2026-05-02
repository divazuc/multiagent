# Map Step Clarification Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users iteratively clarify gaps in their spec directly on the map step, with blocking gaps gating generation and deferred non-blocking gaps tracked as project notes.

**Architecture:** Server changes add gap classification (blocking/non-blocking) and `pendingInfo[]` to the `analyzeSpec` response. The `/analyze` route accepts accumulated clarifications. The `/generate` route saves pending info to disk. The client accumulates clarification rounds in state and rebuilds the map step UI with a clarification textarea, gap panels, and a pending info tracker.

**Tech Stack:** Node.js/Express (server), React + Tailwind (client), Jest + Supertest (tests)

---

## File Map

| File | Change |
|------|--------|
| `workflow-generator/server/services/projectManager.js` | Add `savePendingInfo(slug, items)` |
| `workflow-generator/server/services/projectAnalyzer.js` | Update `analyzeSpec(client, spec, clarifications?)` — new system prompt + response shape |
| `workflow-generator/server/routes/project.js` | `/analyze` accepts `clarifications`; `/generate` accepts + saves `pendingInfo` |
| `workflow-generator/server/tests/projectManager.test.js` | New — tests for `savePendingInfo` |
| `workflow-generator/server/tests/projectAnalyzer.test.js` | New — tests for updated `analyzeSpec` |
| `workflow-generator/client/src/hooks/useWorkflow.js` | Update `apiAnalyzeSpec(spec, clarifications?)` and `apiGenerateProject(slug, spec, workflowMap, pendingInfo?)` |
| `workflow-generator/client/src/components/ProjectMode.jsx` | New state + clarification UI + gap panels + pending info panel |

---

## Task 1: Add `savePendingInfo` to projectManager

**Files:**
- Modify: `workflow-generator/server/services/projectManager.js`
- Create: `workflow-generator/server/tests/projectManager.test.js`

- [ ] **Step 1: Write the failing tests**

Create `workflow-generator/server/tests/projectManager.test.js`:

```javascript
'use strict'

const fs = require('fs')
const path = require('path')
const { savePendingInfo, PROJECTS_DIR } = require('../services/projectManager')

const TEST_SLUG = '__test-pending-info__'
const testDir = path.join(PROJECTS_DIR, TEST_SLUG)

afterEach(() => {
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true })
})

test('savePendingInfo writes a markdown checklist file', () => {
  savePendingInfo(TEST_SLUG, [
    { item: 'Which email provider?', note: 'Will decide after MVP' },
    { item: 'Supabase table name?', note: '' }
  ])
  const filePath = path.join(testDir, 'pending-info.md')
  expect(fs.existsSync(filePath)).toBe(true)
  const content = fs.readFileSync(filePath, 'utf8')
  expect(content).toContain('- [ ] Which email provider?')
  expect(content).toContain('  - Note: Will decide after MVP')
  expect(content).toContain('- [ ] Supabase table name?')
  expect(content).not.toContain('  - Note:\n')
})

test('savePendingInfo handles empty items array', () => {
  savePendingInfo(TEST_SLUG, [])
  const content = fs.readFileSync(path.join(testDir, 'pending-info.md'), 'utf8')
  expect(content).toContain('# Pending Info')
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd workflow-generator && npx jest tests/projectManager.test.js --no-coverage
```

Expected: FAIL — `savePendingInfo is not a function`

- [ ] **Step 3: Add `savePendingInfo` to projectManager.js**

In `workflow-generator/server/services/projectManager.js`, add this function before `module.exports`:

```javascript
/**
 * Save pending info items as a markdown checklist.
 * items: Array<{ item: string, note: string }>
 */
function savePendingInfo(slug, items) {
  createProject(slug)
  const lines = ['# Pending Info\n', 'Information still needed to finalize this project.\n']
  for (const { item, note } of items) {
    lines.push(`- [ ] ${item}`)
    if (note?.trim()) lines.push(`  - Note: ${note}`)
  }
  fs.writeFileSync(
    path.join(PROJECTS_DIR, slug, 'pending-info.md'),
    lines.join('\n'),
    'utf8'
  )
}
```

Then add `savePendingInfo` to `module.exports`:

```javascript
module.exports = {
  listProjects,
  createProject,
  saveSpec,
  loadManifest,
  saveManifest,
  saveWorkflow,
  loadProjectContext,
  loadGlobalContext,
  savePendingInfo,
  PROJECTS_DIR
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd workflow-generator && npx jest tests/projectManager.test.js --no-coverage
```

Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
cd workflow-generator && git add server/services/projectManager.js server/tests/projectManager.test.js
git commit -m "feat: add savePendingInfo to projectManager"
```

---

## Task 2: Update `analyzeSpec` — gap classification + clarifications

**Files:**
- Modify: `workflow-generator/server/services/projectAnalyzer.js`
- Create: `workflow-generator/server/tests/projectAnalyzer.test.js`

- [ ] **Step 1: Write the failing tests**

Create `workflow-generator/server/tests/projectAnalyzer.test.js`:

```javascript
'use strict'

jest.mock('@anthropic-ai/sdk')

const Anthropic = require('@anthropic-ai/sdk')
const { analyzeSpec } = require('../services/projectAnalyzer')

const mockMap = {
  projectName: 'user-onboarding',
  workflows: [
    {
      name: 'User Onboarding',
      role: 'supervisor',
      purpose: 'Orchestrates onboarding flow',
      trigger: 'webhook',
      inputs: 'user data',
      outputs: 'status summary',
      calls: ['Validate Email']
    },
    {
      name: 'Validate Email',
      role: 'sub',
      purpose: 'Validates the email address',
      trigger: 'sub-workflow',
      inputs: 'email string',
      outputs: '{ isValid, reason }',
      calls: []
    }
  ],
  gaps: [{ question: 'Which email validation service?', blocking: false }],
  pendingInfo: []
}

beforeEach(() => {
  Anthropic.mockClear()
  Anthropic.prototype.messages = {
    create: jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(mockMap) }]
    })
  }
})

test('analyzeSpec returns parsed workflow map with classified gaps', async () => {
  const client = new Anthropic()
  const result = await analyzeSpec(client, 'User onboarding spec')
  expect(result.projectName).toBe('user-onboarding')
  expect(result.workflows).toHaveLength(2)
  expect(result.gaps[0]).toEqual({ question: 'Which email validation service?', blocking: false })
  expect(result.pendingInfo).toEqual([])
})

test('analyzeSpec appends clarifications to the user message', async () => {
  const client = new Anthropic()
  const createSpy = jest.spyOn(Anthropic.prototype.messages, 'create')
  await analyzeSpec(client, 'spec text', 'We use SendGrid. Supabase table is "users".')
  const call = createSpy.mock.calls[0][0]
  const userContent = call.messages[0].content
  expect(userContent).toContain('We use SendGrid')
  expect(userContent).toContain('Supabase table is "users"')
})

test('analyzeSpec works without clarifications', async () => {
  const client = new Anthropic()
  const createSpy = jest.spyOn(Anthropic.prototype.messages, 'create')
  await analyzeSpec(client, 'spec text')
  const call = createSpy.mock.calls[0][0]
  const userContent = call.messages[0].content
  expect(userContent).toContain('spec text')
})

test('analyzeSpec throws on malformed LLM response', async () => {
  Anthropic.prototype.messages = {
    create: jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'not json at all' }]
    })
  }
  const client = new Anthropic()
  await expect(analyzeSpec(client, 'spec')).rejects.toThrow(/parse/i)
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd workflow-generator && npx jest tests/projectAnalyzer.test.js --no-coverage
```

Expected: FAIL — tests that check `gaps[0].blocking` and `pendingInfo` will fail because the current response shape has `gaps` as strings.

- [ ] **Step 3: Update `analyzeSpec` in projectAnalyzer.js**

Replace the entire `analyzeSpec` function in `workflow-generator/server/services/projectAnalyzer.js`:

```javascript
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
  "gaps": [
    { "question": "Missing information needed", "blocking": true|false }
  ],
  "pendingInfo": []
}

Gap classification rules:
- blocking: true → the workflow structure CANNOT be correctly determined without this answer (e.g., unknown trigger type, unclear which workflows are needed, ambiguous supervisor/sub relationship)
- blocking: false → generation can proceed with a reasonable placeholder (e.g., email provider choice, specific field names, optional third-party service)

If the user's clarification text contains deferral signals for a gap (phrases like "will provide later", "don't have this", "not sure yet", "TBD", "decide later", or similar), move that deferred item into pendingInfo[] as a descriptive string instead of keeping it in gaps[]. pendingInfo[] items are human-readable reminders of what is still needed.

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
      { role: 'user', content: userMessage }
    ]
  })

  const text = response.content[0].text
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = match ? match[1].trim() : text.trim()

  let parsed
  try {
    parsed = JSON.parse(candidate)
  } catch {
    throw new Error(`Failed to parse workflow map: ${text.slice(0, 200)}`)
  }

  // Normalise: gaps may be strings (legacy) or objects. Ensure object shape.
  if (Array.isArray(parsed.gaps)) {
    parsed.gaps = parsed.gaps.map(g =>
      typeof g === 'string' ? { question: g, blocking: true } : g
    )
  } else {
    parsed.gaps = []
  }

  if (!Array.isArray(parsed.pendingInfo)) parsed.pendingInfo = []

  return parsed
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd workflow-generator && npx jest tests/projectAnalyzer.test.js --no-coverage
```

Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
cd workflow-generator && git add server/services/projectAnalyzer.js server/tests/projectAnalyzer.test.js
git commit -m "feat: classify gaps as blocking/non-blocking, support clarifications in analyzeSpec"
```

---

## Task 3: Update `/analyze` route — accept clarifications

**Files:**
- Modify: `workflow-generator/server/routes/project.js`

- [ ] **Step 1: Update the `/analyze` route handler**

In `workflow-generator/server/routes/project.js`, replace the `/analyze` route:

```javascript
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
```

- [ ] **Step 2: Run the full server test suite to check nothing broke**

```bash
cd workflow-generator && npx jest --no-coverage
```

Expected: All existing tests pass, projectAnalyzer tests pass, projectManager tests pass.

- [ ] **Step 3: Commit**

```bash
cd workflow-generator && git add server/routes/project.js
git commit -m "feat: pass clarifications through /analyze route to analyzeSpec"
```

---

## Task 4: Update `/generate` route — save pendingInfo

**Files:**
- Modify: `workflow-generator/server/routes/project.js`

- [ ] **Step 1: Add `savePendingInfo` import to the route file**

In `workflow-generator/server/routes/project.js`, update the `projectManager` destructure import (top of file):

```javascript
const {
  listProjects, saveSpec, loadManifest, saveManifest,
  saveWorkflow, loadProjectContext, savePendingInfo
} = require('../services/projectManager')
```

- [ ] **Step 2: Update the `/generate` route handler**

Replace the `/generate` route in `workflow-generator/server/routes/project.js`:

```javascript
// Generate all workflows for a project from spec + approved workflow map
router.post('/generate', async (req, res) => {
  const { slug, spec, workflowMap, pendingInfo } = req.body
  if (!slug?.trim()) return res.status(400).json({ error: 'slug is required' })
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
```

- [ ] **Step 3: Run full test suite**

```bash
cd workflow-generator && npx jest --no-coverage
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
cd workflow-generator && git add server/routes/project.js
git commit -m "feat: save pendingInfo to disk on project generate"
```

---

## Task 5: Update client hooks

**Files:**
- Modify: `workflow-generator/client/src/hooks/useWorkflow.js`

- [ ] **Step 1: Update `apiAnalyzeSpec` to accept clarifications**

In `workflow-generator/client/src/hooks/useWorkflow.js`, replace the `apiAnalyzeSpec` function:

```javascript
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
```

- [ ] **Step 2: Update `apiGenerateProject` to accept pendingInfo**

In the same file, replace `apiGenerateProject`:

```javascript
export async function apiGenerateProject(slug, spec, workflowMap, pendingInfo) {
  const res = await fetch('/api/projects/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, spec, workflowMap, pendingInfo: pendingInfo || [] })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`)
  return data
}
```

- [ ] **Step 3: Commit**

```bash
cd workflow-generator && git add client/src/hooks/useWorkflow.js
git commit -m "feat: update apiAnalyzeSpec and apiGenerateProject to support clarifications and pendingInfo"
```

---

## Task 6: Update ProjectMode.jsx — clarification loop UI

**Files:**
- Modify: `workflow-generator/client/src/components/ProjectMode.jsx`

This is the largest change. Replace the entire file with the implementation below.

- [ ] **Step 1: Replace ProjectMode.jsx**

```jsx
import { useState, useRef } from 'react'
import { apiAnalyzeSpec, apiGenerateProject, apiImportProject } from '../hooks/useWorkflow'

const STEPS = ['spec', 'map', 'generate', 'import']

export default function ProjectMode() {
  const [step, setStep] = useState('spec')
  const [spec, setSpec] = useState('')
  const [slug, setSlug] = useState('')
  const [workflowMap, setWorkflowMap] = useState(null)
  const [generated, setGenerated] = useState(null)
  const [importResults, setImportResults] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // Clarification loop state
  const [clarifications, setClarifications] = useState([])       // submitted rounds
  const [currentClarification, setCurrentClarification] = useState('')
  const [pendingInfo, setPendingInfo] = useState([])             // deferred items [{item, note}]
  const [contextExpanded, setContextExpanded] = useState(false)
  const clarificationRef = useRef(null)

  function slugify(name) {
    return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  }

  function applyMap(map) {
    setWorkflowMap(map)
    // Accumulate new pendingInfo items from this analysis round
    if (map.pendingInfo?.length) {
      setPendingInfo(prev => {
        const existing = new Set(prev.map(p => p.item))
        const newItems = map.pendingInfo
          .filter(item => !existing.has(item))
          .map(item => ({ item, note: '' }))
        return [...prev, ...newItems]
      })
    }
  }

  async function handleAnalyze() {
    if (!spec.trim() || !slug.trim()) return
    setLoading(true)
    setError(null)
    try {
      const map = await apiAnalyzeSpec(spec)
      applyMap(map)
      if (!slug && map.projectName) setSlug(slugify(map.projectName))
      setStep('map')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleReanalyze() {
    if (!currentClarification.trim()) return
    const newClarifications = [...clarifications, currentClarification]
    setClarifications(newClarifications)
    setCurrentClarification('')
    setLoading(true)
    setError(null)
    try {
      const map = await apiAnalyzeSpec(spec, newClarifications.join('\n\n---\n'))
      applyMap(map)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleGenerate() {
    setLoading(true)
    setError(null)
    try {
      const data = await apiGenerateProject(slug, spec, workflowMap, pendingInfo)
      setGenerated(data)
      setStep('generate')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleImport() {
    setLoading(true)
    setError(null)
    try {
      const workflows = generated.results.map(r => ({
        name: r.spec.name,
        role: r.spec.role,
        workflow: r.workflow
      }))
      const data = await apiImportProject(slug, workflows)
      setImportResults(data)
      setStep('import')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  function handleDownload(workflow, name) {
    const blob = new Blob([JSON.stringify(workflow, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${name.replace(/\s+/g, '_')}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleReset() {
    setStep('spec')
    setSpec('')
    setSlug('')
    setWorkflowMap(null)
    setGenerated(null)
    setImportResults(null)
    setError(null)
    setClarifications([])
    setCurrentClarification('')
    setPendingInfo([])
    setContextExpanded(false)
  }

  function handleContinueEditing() {
    clarificationRef.current?.focus()
    clarificationRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const blockingGaps = workflowMap?.gaps?.filter(g => g.blocking) ?? []
  const nonBlockingGaps = workflowMap?.gaps?.filter(g => !g.blocking) ?? []
  const canGenerate = blockingGaps.length === 0

  return (
    <div>
      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-6">
        {[
          { id: 'spec', label: '1. Spec' },
          { id: 'map', label: '2. Review map' },
          { id: 'generate', label: '3. Generate' },
          { id: 'import', label: '4. Import' }
        ].map((s, i) => {
          const idx = STEPS.indexOf(step)
          const done = STEPS.indexOf(s.id) < idx
          const active = s.id === step
          return (
            <div key={s.id} className="flex items-center gap-2">
              <span className={`text-xs font-semibold px-2 py-1 rounded ${
                active ? 'bg-indigo-600 text-white' :
                done ? 'bg-green-100 text-green-700' :
                'bg-slate-100 text-slate-400'
              }`}>{s.label}</span>
              {i < 3 && <span className="text-slate-300">→</span>}
            </div>
          )
        })}
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      {/* Step 1: Spec input */}
      {step === 'spec' && (
        <div>
          <div className="mb-4">
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
              Project slug
            </label>
            <input
              className="w-full border-2 border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
              placeholder="e.g. customer-onboarding"
              value={slug}
              onChange={e => setSlug(slugify(e.target.value))}
            />
            <p className="text-xs text-slate-400 mt-1">Used for the project folder name. Lowercase, hyphens only.</p>
          </div>
          <div className="mb-4">
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
              Project spec
            </label>
            <textarea
              className="w-full border-2 border-slate-200 rounded-xl p-4 text-sm leading-relaxed resize-none focus:outline-none focus:border-indigo-400 font-mono"
              rows={14}
              placeholder="Paste your project spec here..."
              value={spec}
              onChange={e => setSpec(e.target.value)}
            />
          </div>
          <button
            onClick={handleAnalyze}
            disabled={loading || !spec.trim() || !slug.trim()}
            className="bg-indigo-600 text-white px-8 py-3 rounded-lg font-semibold text-sm hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Analyzing...' : 'Analyze spec →'}
          </button>
        </div>
      )}

      {/* Step 2: Review workflow map */}
      {step === 'map' && workflowMap && (
        <div>
          <h3 className="font-semibold text-slate-700 mb-1">Proposed workflow system</h3>
          <p className="text-xs text-slate-400 mb-4">Review before generating. Claude will build each workflow with awareness of the others.</p>

          {/* Workflow cards */}
          <div className="space-y-3 mb-4">
            {workflowMap.workflows?.map((wf, i) => (
              <div key={i} className={`border rounded-xl p-4 ${wf.role === 'supervisor' ? 'border-indigo-200 bg-indigo-50' : 'border-slate-200 bg-white'}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-xs font-bold px-2 py-0.5 rounded uppercase ${wf.role === 'supervisor' ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-600'}`}>
                    {wf.role}
                  </span>
                  <span className="font-semibold text-sm text-slate-800">{wf.name}</span>
                </div>
                <p className="text-xs text-slate-500 mb-2">{wf.purpose}</p>
                <div className="grid grid-cols-2 gap-2 text-xs text-slate-500">
                  <div><span className="font-semibold">Trigger:</span> {wf.trigger}</div>
                  <div><span className="font-semibold">Inputs:</span> {wf.inputs}</div>
                  <div className="col-span-2"><span className="font-semibold">Outputs:</span> {wf.outputs}</div>
                  {wf.calls?.length > 0 && (
                    <div className="col-span-2"><span className="font-semibold">Calls:</span> {wf.calls.join(', ')}</div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Blocking gaps — must resolve */}
          {blockingGaps.length > 0 && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
              <div className="text-xs font-semibold text-red-700 uppercase tracking-wide mb-1">Required info — needed before generating</div>
              <ul className="text-sm text-red-700 space-y-1">
                {blockingGaps.map((g, i) => <li key={i}>• {g.question}</li>)}
              </ul>
            </div>
          )}

          {/* Non-blocking gaps — can defer */}
          {nonBlockingGaps.length > 0 && (
            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <div className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-1">Optional info — can defer or generate with placeholders</div>
              <ul className="text-sm text-amber-700 space-y-1">
                {nonBlockingGaps.map((g, i) => <li key={i}>• {g.question}</li>)}
              </ul>
              <p className="text-xs text-amber-600 mt-2">Reply "will provide later" for any you want to defer — they'll be saved as project notes.</p>
            </div>
          )}

          {/* Clarification textarea */}
          <div className="mb-4">
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
              Add clarifications
            </label>
            <textarea
              ref={clarificationRef}
              className="w-full border-2 border-slate-200 rounded-xl p-3 text-sm leading-relaxed resize-none focus:outline-none focus:border-indigo-400"
              rows={4}
              placeholder={
                blockingGaps.length > 0
                  ? 'Answer the required questions above to unlock generation...'
                  : 'Add any clarifications, or type "will provide later" for items you want to defer...'
              }
              value={currentClarification}
              onChange={e => setCurrentClarification(e.target.value)}
            />
            <button
              onClick={handleReanalyze}
              disabled={loading || !currentClarification.trim()}
              className="mt-2 bg-slate-700 text-white px-5 py-2 rounded-lg font-semibold text-sm hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Re-analyzing...' : 'Re-analyze →'}
            </button>
          </div>

          {/* Context added so far (collapsible) */}
          {clarifications.length > 0 && (
            <div className="mb-4 border border-slate-200 rounded-lg overflow-hidden">
              <button
                onClick={() => setContextExpanded(v => !v)}
                className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-slate-500 bg-slate-50 hover:bg-slate-100"
              >
                <span>Context added so far ({clarifications.length} round{clarifications.length !== 1 ? 's' : ''})</span>
                <span>{contextExpanded ? '▲' : '▼'}</span>
              </button>
              {contextExpanded && (
                <div className="px-3 py-2 space-y-2">
                  {clarifications.map((c, i) => (
                    <div key={i} className="text-xs text-slate-500 border-l-2 border-slate-200 pl-2">
                      <div className="font-semibold text-slate-400 mb-0.5">Round {i + 1}</div>
                      <div className="whitespace-pre-wrap">{c}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Pending info panel */}
          {pendingInfo.length > 0 && (
            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <div className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-2">Pending info (to provide later)</div>
              <div className="space-y-2">
                {pendingInfo.map((p, i) => (
                  <div key={i}>
                    <div className="text-sm text-amber-800">• {p.item}</div>
                    <input
                      className="mt-1 w-full border border-amber-200 rounded px-2 py-1 text-xs text-slate-600 bg-white focus:outline-none focus:border-amber-400"
                      placeholder="Your note (optional)..."
                      value={p.note}
                      onChange={e => {
                        setPendingInfo(prev => prev.map((item, idx) =>
                          idx === i ? { ...item, note: e.target.value } : item
                        ))
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action bar */}
          <div className="flex gap-3 flex-wrap">
            <button
              onClick={handleGenerate}
              disabled={loading || !canGenerate}
              title={!canGenerate ? 'Answer the required questions above before generating' : ''}
              className="bg-indigo-600 text-white px-8 py-3 rounded-lg font-semibold text-sm hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? `Generating ${workflowMap.workflows?.length} workflows...` : `Generate ${workflowMap.workflows?.length} workflows →`}
            </button>
            <button
              onClick={handleContinueEditing}
              className="bg-white text-slate-600 border border-slate-200 px-6 py-3 rounded-lg text-sm font-semibold hover:border-slate-300"
            >
              Continue editing spec
            </button>
            <button onClick={() => setStep('spec')} className="bg-white text-slate-400 border border-slate-200 px-4 py-3 rounded-lg text-sm hover:border-slate-300">
              ← Back to spec
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Generated workflows */}
      {step === 'generate' && generated && (
        <div>
          <h3 className="font-semibold text-slate-700 mb-1">Generated workflows</h3>
          <p className="text-xs text-slate-400 mb-4">All workflows saved to <code className="bg-slate-100 px-1 rounded">projects/{slug}/workflows/</code></p>

          <div className="space-y-3 mb-4">
            {generated.results?.map((item, i) => (
              <div key={i} className="border border-slate-200 rounded-xl p-4">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded uppercase ${item.spec.role === 'supervisor' ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-600'}`}>
                      {item.spec.role}
                    </span>
                    <span className="font-semibold text-sm text-slate-800">{item.spec.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-semibold ${item.validation.valid ? 'text-green-600' : 'text-red-500'}`}>
                      {item.validation.valid ? 'Valid' : `${item.validation.errors.length} error(s)`}
                    </span>
                    <button
                      onClick={() => handleDownload(item.workflow, item.spec.name)}
                      className="text-xs bg-slate-100 text-slate-600 px-2 py-1 rounded hover:bg-slate-200"
                    >
                      Download
                    </button>
                  </div>
                </div>
                <p className="text-xs text-slate-500">{item.summary}</p>
                {!item.validation.valid && (
                  <div className="mt-2 text-xs text-red-600 space-y-0.5">
                    {item.validation.errors.map((e, j) => <div key={j}>• {e}</div>)}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Pending info reminder */}
          {pendingInfo.length > 0 && (
            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <div className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-1">Pending info reminder</div>
              <ul className="text-sm text-amber-700 space-y-0.5">
                {pendingInfo.map((p, i) => (
                  <li key={i}>• {p.item}{p.note ? ` — ${p.note}` : ''}</li>
                ))}
              </ul>
              <p className="text-xs text-amber-600 mt-1">Saved to <code className="bg-amber-100 px-1 rounded">projects/{slug}/pending-info.md</code></p>
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={handleImport}
              disabled={loading}
              className="bg-indigo-600 text-white px-8 py-3 rounded-lg font-semibold text-sm hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Importing to n8n...' : 'Import all to n8n →'}
            </button>
            <button onClick={() => generated.results?.forEach(r => handleDownload(r.workflow, r.spec.name))} className="bg-white text-slate-600 border border-slate-200 px-6 py-3 rounded-lg text-sm font-semibold hover:border-slate-300">
              Download all
            </button>
          </div>
        </div>
      )}

      {/* Step 4: Import results */}
      {step === 'import' && importResults && (
        <div>
          <h3 className="font-semibold text-slate-700 mb-1">Import complete</h3>
          <p className="text-xs text-slate-400 mb-4">n8n IDs saved to <code className="bg-slate-100 px-1 rounded">projects/{slug}/manifest.json</code></p>

          <div className="space-y-3 mb-4">
            {importResults.results?.map((r, i) => (
              <div key={i} className={`border rounded-xl p-4 ${r.success ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded uppercase ${r.role === 'supervisor' ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-600'}`}>
                      {r.role}
                    </span>
                    <span className="font-semibold text-sm text-slate-800">{r.name}</span>
                  </div>
                  {r.success && r.workflowUrl && (
                    <a href={r.workflowUrl} target="_blank" rel="noreferrer"
                      className="text-xs bg-indigo-600 text-white px-3 py-1.5 rounded font-semibold hover:bg-indigo-700">
                      Open in n8n
                    </a>
                  )}
                </div>
                {!r.success && <div className="mt-1 text-xs text-red-600">{r.error}</div>}
                {r.success && r.n8nId && (
                  <div className="mt-1 text-xs text-slate-400">ID: {r.n8nId}</div>
                )}
              </div>
            ))}
          </div>

          {/* Pending info reminder */}
          {pendingInfo.length > 0 && (
            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <div className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-1">Still pending</div>
              <ul className="text-sm text-amber-700 space-y-0.5">
                {pendingInfo.map((p, i) => (
                  <li key={i}>• {p.item}{p.note ? ` — ${p.note}` : ''}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700 mb-4">
            <strong>Next step:</strong> Open each sub-workflow in n8n and copy its ID from the URL. Then open the supervisor workflow and update the Execute Sub-workflow nodes with the correct IDs.
          </div>

          <button onClick={handleReset} className="bg-white text-slate-600 border border-slate-200 px-6 py-3 rounded-lg text-sm font-semibold hover:border-slate-300">
            Start new project
          </button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Run full test suite to confirm server tests still pass**

```bash
cd workflow-generator && npx jest --no-coverage
```

Expected: All tests pass.

- [ ] **Step 3: Start the dev server and manually verify the map step**

```bash
cd workflow-generator && npm run dev
```

Open the app, go to Project mode, paste a spec, analyze it. Verify:
- Workflow cards render as before
- Blocking gaps appear in red, non-blocking in amber
- Clarification textarea is visible
- "Re-analyze" button submits and updates the map
- "Context added so far" section appears and expands correctly after first re-analysis
- "Generate X workflows" is disabled while blocking gaps exist
- "Continue editing spec" scrolls focus to the textarea
- Deferred items ("will provide later") appear in the pending info panel

- [ ] **Step 4: Commit**

```bash
cd workflow-generator && git add client/src/components/ProjectMode.jsx
git commit -m "feat: add clarification loop, gap classification, and pending info to map step"
```

---

## Self-Review

**Spec coverage check:**
- [x] Accumulating clarifications (joined with separator) — Task 5 + 6
- [x] Gap classification: blocking/non-blocking — Task 2 system prompt + Task 6 UI
- [x] Re-analyze button re-runs analyzeSpec with all clarifications — Task 6 `handleReanalyze`
- [x] Generate button hidden until no blocking gaps — Task 6 `canGenerate` gate
- [x] "Continue editing spec" focuses clarification textarea — Task 6 `handleContinueEditing` + ref
- [x] "Context added so far" collapsed history — Task 6 `contextExpanded` state
- [x] Deferred items recognized by Claude → pendingInfo[] — Task 2 system prompt
- [x] pendingInfo accumulated across rounds in client state — Task 6 `applyMap`
- [x] Inline notes per deferred item — Task 6 `setPendingInfo` with note field
- [x] Pending info saved to disk on generate — Task 4 `savePendingInfo` call
- [x] Pending info panel shown on generate + import steps as reminder — Task 6 both steps
- [x] savePendingInfo writes markdown checklist — Task 1
