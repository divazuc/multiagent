# n8n Workflow Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone React + Express web app where non-technical users describe an n8n workflow in plain language and receive a validated, importable `.json` file.

**Architecture:** Express backend holds the Anthropic API key, calls Claude with the n8n node schema in the system prompt, validates the output with Ajv, and serves the React build as static files. The frontend has two modes: Build (natural language → new workflow) and Edit (load existing `.json` or pull from live n8n → describe change → diff + download). A safe test-run feature imports the workflow to n8n as inactive and shows plain-language execution results.

**Tech Stack:** React 18, Vite, Tailwind CSS, Node.js 20+, Express 4, Anthropic SDK (`@anthropic-ai/sdk`), Ajv 8, Jest, Supertest

---

### Task 1: Project Scaffold

**Files:**
- Create: `workflow-generator/package.json`
- Create: `workflow-generator/.env.example`
- Create: `workflow-generator/server/package.json`
- Create: `workflow-generator/client/package.json`
- Create: `workflow-generator/client/vite.config.js`
- Create: `workflow-generator/client/index.html`

- [ ] **Step 1: Create root workspace**

```bash
mkdir workflow-generator && cd workflow-generator
```

Create `workflow-generator/package.json`:
```json
{
  "name": "n8n-workflow-generator",
  "private": true,
  "workspaces": ["client", "server"],
  "scripts": {
    "dev": "concurrently \"npm run dev --workspace=server\" \"npm run dev --workspace=client\"",
    "test": "npm run test --workspace=server"
  },
  "devDependencies": {
    "concurrently": "^8.2.2"
  }
}
```

- [ ] **Step 2: Create server package**

Create `workflow-generator/server/package.json`:
```json
{
  "name": "workflow-generator-server",
  "version": "1.0.0",
  "type": "commonjs",
  "main": "index.js",
  "scripts": {
    "dev": "node --watch index.js",
    "start": "node index.js",
    "test": "jest --runInBand"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.26.0",
    "ajv": "^8.17.1",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.19.2"
  },
  "devDependencies": {
    "jest": "^29.7.0",
    "supertest": "^7.0.0"
  },
  "jest": {
    "testEnvironment": "node",
    "testMatch": ["**/tests/**/*.test.js"]
  }
}
```

- [ ] **Step 3: Create client package**

Create `workflow-generator/client/package.json`:
```json
{
  "name": "workflow-generator-client",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite --port 5173",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.1",
    "autoprefixer": "^10.4.19",
    "postcss": "^8.4.38",
    "tailwindcss": "^3.4.4",
    "vite": "^5.3.1"
  }
}
```

- [ ] **Step 4: Create Vite config with proxy**

Create `workflow-generator/client/vite.config.js`:
```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3001'
    }
  }
})
```

- [ ] **Step 5: Create HTML shell**

Create `workflow-generator/client/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>n8n Workflow Generator</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Create .env.example**

Create `workflow-generator/.env.example`:
```
ANTHROPIC_API_KEY=your_anthropic_api_key_here
PORT=3001
```

Copy to `.env` and fill in your Anthropic key:
```bash
cp .env.example .env
```

- [ ] **Step 7: Install dependencies**

```bash
cd workflow-generator
npm install
cd server && npm install
cd ../client && npm install
```

- [ ] **Step 8: Commit scaffold**

```bash
git add workflow-generator/
git commit -m "feat: scaffold workflow-generator monorepo"
```

---

### Task 2: n8n Schema Catalogue

**Files:**
- Create: `workflow-generator/server/schema/n8n-nodes-v1.json`

This file is the ground truth for validation and is embedded in the Claude system prompt. Each entry defines `typeVersion` range, required parameters, and whether the node is a trigger.

- [ ] **Step 1: Create schema catalogue**

Create `workflow-generator/server/schema/n8n-nodes-v1.json`:
```json
{
  "version": "1.0",
  "n8nVersion": "1.x",
  "nodes": {
    "n8n-nodes-base.webhook": {
      "displayName": "Webhook",
      "isTrigger": true,
      "typeVersions": [1, 2],
      "requiredParameters": ["path"],
      "optionalParameters": ["httpMethod", "responseMode", "options"]
    },
    "n8n-nodes-base.manualTrigger": {
      "displayName": "Manual Trigger",
      "isTrigger": true,
      "typeVersions": [1],
      "requiredParameters": [],
      "optionalParameters": []
    },
    "n8n-nodes-base.scheduleTrigger": {
      "displayName": "Schedule Trigger",
      "isTrigger": true,
      "typeVersions": [1],
      "requiredParameters": [],
      "optionalParameters": ["rule"]
    },
    "n8n-nodes-base.httpRequest": {
      "displayName": "HTTP Request",
      "isTrigger": false,
      "typeVersions": [1, 2, 3, 4, 4.1, 4.2],
      "requiredParameters": ["url"],
      "optionalParameters": ["method", "headers", "body", "authentication", "options"]
    },
    "n8n-nodes-base.code": {
      "displayName": "Code",
      "isTrigger": false,
      "typeVersions": [1, 2],
      "requiredParameters": [],
      "optionalParameters": ["jsCode", "pythonCode", "language", "mode"]
    },
    "n8n-nodes-base.set": {
      "displayName": "Edit Fields (Set)",
      "isTrigger": false,
      "typeVersions": [1, 2, 3, 3.2, 3.3, 3.4],
      "requiredParameters": [],
      "optionalParameters": ["mode", "fields", "options"]
    },
    "n8n-nodes-base.if": {
      "displayName": "IF",
      "isTrigger": false,
      "typeVersions": [1, 2],
      "requiredParameters": ["conditions"],
      "optionalParameters": ["combineOperation"]
    },
    "n8n-nodes-base.switch": {
      "displayName": "Switch",
      "isTrigger": false,
      "typeVersions": [1, 2, 3],
      "requiredParameters": [],
      "optionalParameters": ["mode", "rules", "options"]
    },
    "n8n-nodes-base.merge": {
      "displayName": "Merge",
      "isTrigger": false,
      "typeVersions": [1, 2, 2.1, 3],
      "requiredParameters": [],
      "optionalParameters": ["mode", "mergeByFields", "options"]
    },
    "n8n-nodes-base.respondToWebhook": {
      "displayName": "Respond to Webhook",
      "isTrigger": false,
      "typeVersions": [1, 1.1],
      "requiredParameters": [],
      "optionalParameters": ["respondWith", "responseBody", "responseHeaders", "options"]
    },
    "n8n-nodes-base.executeWorkflow": {
      "displayName": "Execute Sub-workflow",
      "isTrigger": false,
      "typeVersions": [1],
      "requiredParameters": ["workflowId"],
      "optionalParameters": ["mode", "workflowInputs", "options"]
    },
    "n8n-nodes-base.postgres": {
      "displayName": "Postgres",
      "isTrigger": false,
      "typeVersions": [1, 2, 2.1, 2.2, 2.3, 2.4, 2.5],
      "requiredParameters": [],
      "optionalParameters": ["operation", "query", "table", "options"]
    },
    "n8n-nodes-base.emailSend": {
      "displayName": "Send Email",
      "isTrigger": false,
      "typeVersions": [1, 2, 2.1],
      "requiredParameters": ["toEmail", "subject"],
      "optionalParameters": ["text", "html", "fromEmail", "options"]
    },
    "n8n-nodes-base.slack": {
      "displayName": "Slack",
      "isTrigger": false,
      "typeVersions": [1, 2, 2.1, 2.2],
      "requiredParameters": [],
      "optionalParameters": ["resource", "operation", "channel", "text", "options"]
    },
    "n8n-nodes-base.googleSheets": {
      "displayName": "Google Sheets",
      "isTrigger": false,
      "typeVersions": [1, 2, 4, 4.1, 4.2, 4.3, 4.4],
      "requiredParameters": [],
      "optionalParameters": ["resource", "operation", "documentId", "sheetName", "options"]
    },
    "n8n-nodes-base.noOp": {
      "displayName": "No Operation",
      "isTrigger": false,
      "typeVersions": [1],
      "requiredParameters": [],
      "optionalParameters": []
    },
    "n8n-nodes-base.stickyNote": {
      "displayName": "Sticky Note",
      "isTrigger": false,
      "typeVersions": [1],
      "requiredParameters": [],
      "optionalParameters": ["content", "height", "width", "color"]
    },
    "n8n-nodes-base.wait": {
      "displayName": "Wait",
      "isTrigger": false,
      "typeVersions": [1],
      "requiredParameters": [],
      "optionalParameters": ["unit", "amount", "resume"]
    },
    "@n8n/n8n-nodes-langchain.chatTrigger": {
      "displayName": "Chat Trigger",
      "isTrigger": true,
      "typeVersions": [1],
      "requiredParameters": [],
      "optionalParameters": ["options"]
    }
  }
}
```

- [ ] **Step 2: Commit catalogue**

```bash
git add workflow-generator/server/schema/
git commit -m "feat: add n8n node schema catalogue v1"
```

---

### Task 3: Validator Service

**Files:**
- Create: `workflow-generator/server/services/validator.js`
- Create: `workflow-generator/server/tests/validator.test.js`

Rules checked (in order):
1. All nodes have required base fields (`id`, `name`, `type`, `typeVersion`, `position`, `parameters`)
2. All node `type` values exist in the schema catalogue
3. All connection references point to node names that exist in the workflow
4. No orphaned non-trigger nodes (every non-trigger node reachable from a trigger)
5. At least one trigger node exists

- [ ] **Step 1: Write failing tests**

Create `workflow-generator/server/tests/validator.test.js`:
```js
const { validateWorkflow } = require('../services/validator')
const catalogue = require('../schema/n8n-nodes-v1.json')

const baseNode = (overrides = {}) => ({
  id: 'node-1',
  name: 'Webhook',
  type: 'n8n-nodes-base.webhook',
  typeVersion: 2,
  position: [100, 200],
  parameters: { path: 'test' },
  ...overrides
})

const minimalWorkflow = {
  name: 'Test Workflow',
  nodes: [baseNode()],
  connections: {},
  settings: { executionOrder: 'v1' }
}

test('accepts a valid minimal workflow', () => {
  const result = validateWorkflow(minimalWorkflow, catalogue)
  expect(result.valid).toBe(true)
  expect(result.errors).toHaveLength(0)
})

test('rejects node missing required base field', () => {
  const wf = {
    ...minimalWorkflow,
    nodes: [baseNode({ id: undefined })]
  }
  const result = validateWorkflow(wf, catalogue)
  expect(result.valid).toBe(false)
  expect(result.errors[0]).toMatch(/id/)
})

test('rejects unknown node type', () => {
  const wf = {
    ...minimalWorkflow,
    nodes: [baseNode({ type: 'n8n-nodes-base.doesNotExist' })]
  }
  const result = validateWorkflow(wf, catalogue)
  expect(result.valid).toBe(false)
  expect(result.errors[0]).toMatch(/unknown node type/i)
})

test('rejects connection referencing non-existent node', () => {
  const wf = {
    ...minimalWorkflow,
    connections: {
      'Webhook': { main: [[{ node: 'Ghost Node', type: 'main', index: 0 }]] }
    }
  }
  const result = validateWorkflow(wf, catalogue)
  expect(result.valid).toBe(false)
  expect(result.errors[0]).toMatch(/Ghost Node/)
})

test('rejects workflow with no trigger node', () => {
  const wf = {
    ...minimalWorkflow,
    nodes: [baseNode({ type: 'n8n-nodes-base.code', parameters: {} })]
  }
  const result = validateWorkflow(wf, catalogue)
  expect(result.valid).toBe(false)
  expect(result.errors[0]).toMatch(/trigger/i)
})

test('rejects orphaned non-trigger node', () => {
  const wf = {
    name: 'Test',
    nodes: [
      baseNode({ id: 'n1', name: 'Webhook' }),
      { id: 'n2', name: 'Orphan', type: 'n8n-nodes-base.code', typeVersion: 2, position: [300, 200], parameters: {} }
    ],
    connections: {},
    settings: { executionOrder: 'v1' }
  }
  const result = validateWorkflow(wf, catalogue)
  expect(result.valid).toBe(false)
  expect(result.errors[0]).toMatch(/Orphan/)
})
```

- [ ] **Step 2: Run tests — verify all fail**

```bash
cd workflow-generator/server && npx jest tests/validator.test.js --no-coverage
```

Expected: 6 failures — `validateWorkflow` not defined.

- [ ] **Step 3: Implement validator**

Create `workflow-generator/server/services/validator.js`:
```js
'use strict'

const REQUIRED_NODE_FIELDS = ['id', 'name', 'type', 'typeVersion', 'position', 'parameters']

/**
 * Validate an n8n workflow JSON against the node catalogue.
 * @param {object} workflow - Parsed n8n workflow JSON
 * @param {object} catalogue - n8n-nodes-v1.json contents
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateWorkflow(workflow, catalogue) {
  const errors = []
  const nodes = workflow.nodes || []
  const connections = workflow.connections || {}
  const nodeNames = new Set(nodes.map(n => n.name))

  // Rule 1: required base fields
  for (const node of nodes) {
    for (const field of REQUIRED_NODE_FIELDS) {
      if (node[field] === undefined || node[field] === null) {
        errors.push(`Node "${node.name || node.id || '?'}": missing required field "${field}"`)
      }
    }
  }

  // Rule 2: known node type
  for (const node of nodes) {
    if (node.type && !catalogue.nodes[node.type]) {
      errors.push(`Node "${node.name}": unknown node type "${node.type}"`)
    }
  }

  // Rule 3: connection references exist
  for (const [sourceName, outputs] of Object.entries(connections)) {
    const allOutputs = Object.values(outputs).flat(2)
    for (const conn of allOutputs) {
      if (conn && conn.node && !nodeNames.has(conn.node)) {
        errors.push(`Connection from "${sourceName}" references non-existent node "${conn.node}"`)
      }
    }
  }

  // Rule 4: at least one trigger
  const triggerTypes = new Set(
    Object.entries(catalogue.nodes)
      .filter(([, def]) => def.isTrigger)
      .map(([type]) => type)
  )
  const hasTrigger = nodes.some(n => triggerTypes.has(n.type))
  if (!hasTrigger) {
    errors.push('Workflow has no trigger node. Add a Webhook, Schedule Trigger, or similar.')
  }

  // Rule 5: no orphaned non-trigger nodes
  if (hasTrigger) {
    const reachable = new Set()
    // seed with trigger node names
    for (const node of nodes) {
      if (triggerTypes.has(node.type)) reachable.add(node.name)
    }
    // BFS over connections
    let changed = true
    while (changed) {
      changed = false
      for (const [source, outputs] of Object.entries(connections)) {
        if (reachable.has(source)) {
          const targets = Object.values(outputs).flat(2)
            .filter(Boolean).map(c => c.node).filter(Boolean)
          for (const t of targets) {
            if (!reachable.has(t)) { reachable.add(t); changed = true }
          }
        }
      }
    }
    for (const node of nodes) {
      if (!triggerTypes.has(node.type) && !reachable.has(node.name)) {
        errors.push(`Node "${node.name}" is orphaned (not reachable from any trigger)`)
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

module.exports = { validateWorkflow }
```

- [ ] **Step 4: Run tests — verify all pass**

```bash
cd workflow-generator/server && npx jest tests/validator.test.js --no-coverage
```

Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add workflow-generator/server/services/validator.js workflow-generator/server/tests/validator.test.js
git commit -m "feat: add workflow validator with 5 structural rules"
```

---

### Task 4: System Prompt Builder

**Files:**
- Create: `workflow-generator/server/prompts/system.js`

The system prompt is the most important piece — it tells Claude what valid n8n JSON looks like. It injects the schema catalogue so Claude knows every valid node type.

- [ ] **Step 1: Create prompt builder**

Create `workflow-generator/server/prompts/system.js`:
```js
'use strict'

const catalogue = require('../schema/n8n-nodes-v1.json')

const NODE_LIST = Object.entries(catalogue.nodes)
  .map(([type, def]) => `- ${type} (${def.displayName})${def.isTrigger ? ' [TRIGGER]' : ''}`)
  .join('\n')

const SYSTEM_PROMPT = `You are an n8n workflow JSON generator. You produce valid n8n 1.x workflow JSON that can be imported directly into n8n.

## Output Format

Always respond with a JSON object in this exact shape:
{
  "workflow": { ...full n8n workflow JSON... },
  "summary": "One sentence describing what the workflow does in plain English",
  "nodes_used": ["DisplayName1", "DisplayName2"]
}

## n8n Workflow JSON Structure

A valid n8n workflow JSON has this shape:
{
  "name": "Workflow Name",
  "nodes": [ ...node objects... ],
  "connections": { ...connections object... },
  "active": false,
  "settings": { "executionOrder": "v1" }
}

Each node object:
{
  "id": "unique-uuid-string",
  "name": "Human Readable Node Name",
  "type": "n8n-nodes-base.nodeType",
  "typeVersion": 2,
  "position": [x, y],
  "parameters": { ...node-specific parameters... }
}

Connections format:
{
  "Source Node Name": {
    "main": [
      [{ "node": "Target Node Name", "type": "main", "index": 0 }]
    ]
  }
}

Position nodes sensibly: trigger at [100, 200], subsequent nodes at [400, 200], [700, 200], etc. Branch nodes spread vertically.

## Valid Node Types

Only use node types from this list:
${NODE_LIST}

## Rules

1. Every workflow must have at least one [TRIGGER] node.
2. Every non-trigger node must be reachable from a trigger via connections.
3. Node "id" fields must be unique UUIDs (use format "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx").
4. Node "name" fields must be unique within the workflow.
5. Connection references use the node "name" field, not "id".
6. Set "active": false always — the user activates manually in n8n.
7. Credential fields should use placeholder objects: { "id": "CREDENTIAL_ID", "name": "Your Credential Name" }. The user fills these in after importing.
8. For HTTP Request nodes calling the Anthropic API, use model "claude-sonnet-4-6".

## Edit Mode

When given an existing workflow JSON and a change instruction, return the full modified workflow (not a diff). Apply only the requested change — do not restructure or rename existing nodes.`

/**
 * @returns {string} The system prompt to use for all LLM calls
 */
function getSystemPrompt() {
  return SYSTEM_PROMPT
}

module.exports = { getSystemPrompt }
```

- [ ] **Step 2: Commit**

```bash
git add workflow-generator/server/prompts/system.js
git commit -m "feat: add LLM system prompt with n8n schema catalogue"
```

---

### Task 5: LLM Service

**Files:**
- Create: `workflow-generator/server/services/llm.js`
- Create: `workflow-generator/server/tests/llm.test.js`

- [ ] **Step 1: Write failing tests**

Create `workflow-generator/server/tests/llm.test.js`:
```js
jest.mock('@anthropic-ai/sdk')

const Anthropic = require('@anthropic-ai/sdk')
const { generateWorkflow, editWorkflow } = require('../services/llm')

const mockWorkflow = {
  name: 'Test',
  nodes: [{
    id: 'abc-123',
    name: 'Webhook',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position: [100, 200],
    parameters: { path: 'test' }
  }],
  connections: {},
  active: false,
  settings: { executionOrder: 'v1' }
}

const mockLLMResponse = JSON.stringify({
  workflow: mockWorkflow,
  summary: 'Triggers on a webhook',
  nodes_used: ['Webhook']
})

beforeEach(() => {
  Anthropic.mockClear()
  Anthropic.prototype.messages = {
    create: jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: mockLLMResponse }]
    })
  }
})

test('generateWorkflow returns parsed workflow and summary', async () => {
  const client = new Anthropic()
  const result = await generateWorkflow(client, 'trigger on a webhook')
  expect(result.workflow).toEqual(mockWorkflow)
  expect(result.summary).toBe('Triggers on a webhook')
  expect(result.nodes_used).toEqual(['Webhook'])
})

test('generateWorkflow throws on malformed LLM response', async () => {
  Anthropic.prototype.messages = {
    create: jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'not json' }]
    })
  }
  const client = new Anthropic()
  await expect(generateWorkflow(client, 'test')).rejects.toThrow(/parse/i)
})

test('editWorkflow passes existing JSON to LLM', async () => {
  const client = new Anthropic()
  const createSpy = jest.spyOn(Anthropic.prototype.messages, 'create')
  await editWorkflow(client, mockWorkflow, 'add a Slack node')
  const call = createSpy.mock.calls[0][0]
  const userMsg = call.messages[0].content
  expect(userMsg).toContain('add a Slack node')
  expect(userMsg).toContain('"name": "Test"')
})
```

- [ ] **Step 2: Run tests — verify all fail**

```bash
cd workflow-generator/server && npx jest tests/llm.test.js --no-coverage
```

Expected: 3 failures.

- [ ] **Step 3: Implement LLM service**

Create `workflow-generator/server/services/llm.js`:
```js
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
    // Claude may wrap JSON in a code block — strip it
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
```

- [ ] **Step 4: Run tests — verify all pass**

```bash
cd workflow-generator/server && npx jest tests/llm.test.js --no-coverage
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add workflow-generator/server/services/llm.js workflow-generator/server/tests/llm.test.js
git commit -m "feat: add LLM service for workflow generation and editing"
```

---

### Task 6: Differ Service

**Files:**
- Create: `workflow-generator/server/services/differ.js`
- Create: `workflow-generator/server/tests/differ.test.js`

Produces a human-readable diff between two workflow JSONs (for Edit mode output).

- [ ] **Step 1: Write failing tests**

Create `workflow-generator/server/tests/differ.test.js`:
```js
const { diffWorkflows } = require('../services/differ')

const base = {
  nodes: [
    { name: 'Webhook', type: 'n8n-nodes-base.webhook' },
    { name: 'Code', type: 'n8n-nodes-base.code' }
  ],
  connections: {
    'Webhook': { main: [[{ node: 'Code', type: 'main', index: 0 }]] }
  }
}

test('detects added node', () => {
  const modified = {
    nodes: [...base.nodes, { name: 'Slack', type: 'n8n-nodes-base.slack' }],
    connections: base.connections
  }
  const diff = diffWorkflows(base, modified)
  expect(diff.added).toContain('Slack')
  expect(diff.removed).toHaveLength(0)
})

test('detects removed node', () => {
  const modified = { nodes: [base.nodes[0]], connections: {} }
  const diff = diffWorkflows(base, modified)
  expect(diff.removed).toContain('Code')
  expect(diff.added).toHaveLength(0)
})

test('detects added connection', () => {
  const modified = {
    nodes: base.nodes,
    connections: {
      ...base.connections,
      'Code': { main: [[{ node: 'Webhook', type: 'main', index: 0 }]] }
    }
  }
  const diff = diffWorkflows(base, modified)
  expect(diff.connectionsAdded.some(c => c.includes('Code'))).toBe(true)
})

test('returns empty diff for identical workflows', () => {
  const diff = diffWorkflows(base, base)
  expect(diff.added).toHaveLength(0)
  expect(diff.removed).toHaveLength(0)
  expect(diff.connectionsAdded).toHaveLength(0)
  expect(diff.connectionsRemoved).toHaveLength(0)
})
```

- [ ] **Step 2: Run tests — verify all fail**

```bash
cd workflow-generator/server && npx jest tests/differ.test.js --no-coverage
```

Expected: 4 failures.

- [ ] **Step 3: Implement differ**

Create `workflow-generator/server/services/differ.js`:
```js
'use strict'

/**
 * Compare two n8n workflow objects and return a human-readable diff.
 * @param {object} before
 * @param {object} after
 * @returns {{ added: string[], removed: string[], connectionsAdded: string[], connectionsRemoved: string[] }}
 */
function diffWorkflows(before, after) {
  const beforeNames = new Set((before.nodes || []).map(n => n.name))
  const afterNames = new Set((after.nodes || []).map(n => n.name))

  const added = [...afterNames].filter(n => !beforeNames.has(n))
  const removed = [...beforeNames].filter(n => !afterNames.has(n))

  const beforeConns = flattenConnections(before.connections || {})
  const afterConns = flattenConnections(after.connections || {})

  const connectionsAdded = afterConns.filter(c => !beforeConns.includes(c))
  const connectionsRemoved = beforeConns.filter(c => !afterConns.includes(c))

  return { added, removed, connectionsAdded, connectionsRemoved }
}

/**
 * Flatten connections object into readable strings like "Webhook → Code"
 */
function flattenConnections(connections) {
  const result = []
  for (const [source, outputs] of Object.entries(connections)) {
    const targets = Object.values(outputs).flat(2)
      .filter(Boolean).map(c => c.node).filter(Boolean)
    for (const target of targets) {
      result.push(`${source} → ${target}`)
    }
  }
  return result
}

module.exports = { diffWorkflows }
```

- [ ] **Step 4: Run tests — verify all pass**

```bash
cd workflow-generator/server && npx jest tests/differ.test.js --no-coverage
```

Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add workflow-generator/server/services/differ.js workflow-generator/server/tests/differ.test.js
git commit -m "feat: add differ service for human-readable workflow diffs"
```

---

### Task 7: n8n API Client

**Files:**
- Create: `workflow-generator/server/services/n8nClient.js`
- Create: `workflow-generator/server/tests/n8nClient.test.js`

Used for Edit mode (pull workflows) and the safe test-run feature.

- [ ] **Step 1: Write failing tests**

Create `workflow-generator/server/tests/n8nClient.test.js`:
```js
const { createN8nClient } = require('../services/n8nClient')

// Mock global fetch
global.fetch = jest.fn()

const client = createN8nClient('http://localhost:5678', 'test-api-key')

const mockWorkflow = { id: 'wf-1', name: 'My Workflow', nodes: [], connections: {} }

beforeEach(() => { fetch.mockClear() })

test('listWorkflows calls correct endpoint with auth header', async () => {
  fetch.mockResolvedValue({
    ok: true,
    json: async () => ({ data: [mockWorkflow] })
  })
  const result = await client.listWorkflows()
  expect(fetch).toHaveBeenCalledWith(
    'http://localhost:5678/api/v1/workflows',
    expect.objectContaining({ headers: expect.objectContaining({ 'X-N8N-API-KEY': 'test-api-key' }) })
  )
  expect(result).toEqual([mockWorkflow])
})

test('getWorkflow fetches single workflow by id', async () => {
  fetch.mockResolvedValue({ ok: true, json: async () => mockWorkflow })
  const result = await client.getWorkflow('wf-1')
  expect(fetch).toHaveBeenCalledWith(
    'http://localhost:5678/api/v1/workflows/wf-1',
    expect.anything()
  )
  expect(result).toEqual(mockWorkflow)
})

test('importWorkflow POSTs workflow as inactive', async () => {
  fetch.mockResolvedValue({ ok: true, json: async () => ({ id: 'new-wf', ...mockWorkflow }) })
  const result = await client.importWorkflow(mockWorkflow)
  const call = fetch.mock.calls[0]
  const body = JSON.parse(call[1].body)
  expect(body.active).toBe(false)
  expect(result.id).toBe('new-wf')
})

test('deleteWorkflow calls DELETE endpoint', async () => {
  fetch.mockResolvedValue({ ok: true, json: async () => ({}) })
  await client.deleteWorkflow('wf-1')
  expect(fetch).toHaveBeenCalledWith(
    'http://localhost:5678/api/v1/workflows/wf-1',
    expect.objectContaining({ method: 'DELETE' })
  )
})

test('throws on non-ok response', async () => {
  fetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({ message: 'Unauthorized' }) })
  await expect(client.listWorkflows()).rejects.toThrow(/401/)
})
```

- [ ] **Step 2: Run tests — verify all fail**

```bash
cd workflow-generator/server && npx jest tests/n8nClient.test.js --no-coverage
```

Expected: 5 failures.

- [ ] **Step 3: Implement n8n client**

Create `workflow-generator/server/services/n8nClient.js`:
```js
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
      return request('/api/v1/workflows', {
        method: 'POST',
        body: JSON.stringify({ ...workflow, active: false })
      })
    },

    deleteWorkflow(id) {
      return request(`/api/v1/workflows/${id}`, { method: 'DELETE' })
    },

    async triggerManualTest(workflowId) {
      // Execute via n8n's manual execute endpoint
      return request(`/api/v1/workflows/${workflowId}/execute`, { method: 'POST', body: '{}' })
    },

    getExecution(executionId) {
      return request(`/api/v1/executions/${executionId}`)
    }
  }
}

module.exports = { createN8nClient }
```

- [ ] **Step 4: Run tests — verify all pass**

```bash
cd workflow-generator/server && npx jest tests/n8nClient.test.js --no-coverage
```

Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add workflow-generator/server/services/n8nClient.js workflow-generator/server/tests/n8nClient.test.js
git commit -m "feat: add n8n API client for workflow list, import, test, and delete"
```

---

### Task 8: Generate API Route

**Files:**
- Create: `workflow-generator/server/routes/generate.js`
- Create: `workflow-generator/server/tests/generate.test.js`

`POST /api/generate` — runs LLM → validates → auto-retries once on validation failure.

- [ ] **Step 1: Write failing tests**

Create `workflow-generator/server/tests/generate.test.js`:
```js
jest.mock('@anthropic-ai/sdk')
jest.mock('../services/llm')

const request = require('supertest')
const express = require('express')
const generateRouter = require('../routes/generate')
const { generateWorkflow } = require('../services/llm')

const app = express()
app.use(express.json())
app.use('/api/generate', generateRouter)

const validWorkflow = {
  name: 'Test',
  nodes: [{
    id: 'abc-123', name: 'Webhook', type: 'n8n-nodes-base.webhook',
    typeVersion: 2, position: [100, 200], parameters: { path: 'test' }
  }],
  connections: {},
  active: false,
  settings: { executionOrder: 'v1' }
}

test('POST /api/generate returns workflow and summary', async () => {
  generateWorkflow.mockResolvedValue({ workflow: validWorkflow, summary: 'Webhook workflow', nodes_used: ['Webhook'] })
  const res = await request(app).post('/api/generate').send({ description: 'trigger on webhook' })
  expect(res.status).toBe(200)
  expect(res.body.workflow).toEqual(validWorkflow)
  expect(res.body.summary).toBe('Webhook workflow')
  expect(res.body.validation.valid).toBe(true)
})

test('POST /api/generate returns 400 when description missing', async () => {
  const res = await request(app).post('/api/generate').send({})
  expect(res.status).toBe(400)
  expect(res.body.error).toMatch(/description/i)
})

test('POST /api/generate retries once and returns errors on persistent validation failure', async () => {
  const badWorkflow = { name: 'Bad', nodes: [{ id: '1', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [0,0], parameters: {} }], connections: {}, active: false, settings: {} }
  generateWorkflow.mockResolvedValue({ workflow: badWorkflow, summary: 'bad', nodes_used: [] })
  const res = await request(app).post('/api/generate').send({ description: 'no trigger workflow' })
  expect(generateWorkflow).toHaveBeenCalledTimes(2) // original + retry
  expect(res.status).toBe(422)
  expect(res.body.errors).toBeDefined()
})
```

- [ ] **Step 2: Run tests — verify all fail**

```bash
cd workflow-generator/server && npx jest tests/generate.test.js --no-coverage
```

Expected: 3 failures.

- [ ] **Step 3: Implement generate route**

Create `workflow-generator/server/routes/generate.js`:
```js
'use strict'

const { Router } = require('express')
const Anthropic = require('@anthropic-ai/sdk')
const { generateWorkflow } = require('../services/llm')
const { validateWorkflow } = require('../services/validator')
const catalogue = require('../schema/n8n-nodes-v1.json')

const router = Router()

router.post('/', async (req, res) => {
  const { description } = req.body
  if (!description || typeof description !== 'string' || !description.trim()) {
    return res.status(400).json({ error: 'description is required' })
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  let result
  try {
    result = await generateWorkflow(client, description)
  } catch (err) {
    return res.status(500).json({ error: `LLM error: ${err.message}` })
  }

  let validation = validateWorkflow(result.workflow, catalogue)

  // Auto-retry once with errors fed back to Claude
  if (!validation.valid) {
    const retryDescription = `${description}\n\nYour previous attempt had these validation errors — fix them:\n${validation.errors.join('\n')}`
    try {
      result = await generateWorkflow(client, retryDescription)
      validation = validateWorkflow(result.workflow, catalogue)
    } catch {
      // swallow retry error — return original validation errors
    }
  }

  if (!validation.valid) {
    return res.status(422).json({ errors: validation.errors, partial: result })
  }

  return res.json({
    workflow: result.workflow,
    summary: result.summary,
    nodes_used: result.nodes_used,
    validation
  })
})

module.exports = router
```

- [ ] **Step 4: Run tests — verify all pass**

```bash
cd workflow-generator/server && npx jest tests/generate.test.js --no-coverage
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add workflow-generator/server/routes/generate.js workflow-generator/server/tests/generate.test.js
git commit -m "feat: add POST /api/generate route with auto-retry on validation failure"
```

---

### Task 9: Edit API Route

**Files:**
- Create: `workflow-generator/server/routes/edit.js`

`POST /api/edit` — receives existing workflow JSON + change description, returns modified workflow + diff.

- [ ] **Step 1: Implement edit route**

Create `workflow-generator/server/routes/edit.js`:
```js
'use strict'

const { Router } = require('express')
const Anthropic = require('@anthropic-ai/sdk')
const { editWorkflow } = require('../services/llm')
const { validateWorkflow } = require('../services/validator')
const { diffWorkflows } = require('../services/differ')
const catalogue = require('../schema/n8n-nodes-v1.json')

const router = Router()

router.post('/', async (req, res) => {
  const { workflow: existingWorkflow, changeDescription } = req.body

  if (!existingWorkflow || typeof existingWorkflow !== 'object') {
    return res.status(400).json({ error: 'workflow is required and must be a JSON object' })
  }
  if (!changeDescription || typeof changeDescription !== 'string' || !changeDescription.trim()) {
    return res.status(400).json({ error: 'changeDescription is required' })
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  let result
  try {
    result = await editWorkflow(client, existingWorkflow, changeDescription)
  } catch (err) {
    return res.status(500).json({ error: `LLM error: ${err.message}` })
  }

  let validation = validateWorkflow(result.workflow, catalogue)

  if (!validation.valid) {
    const retryDesc = `${changeDescription}\n\nYour previous attempt had these validation errors — fix them:\n${validation.errors.join('\n')}`
    try {
      result = await editWorkflow(client, existingWorkflow, retryDesc)
      validation = validateWorkflow(result.workflow, catalogue)
    } catch { /* swallow */ }
  }

  if (!validation.valid) {
    return res.status(422).json({ errors: validation.errors, partial: result })
  }

  const diff = diffWorkflows(existingWorkflow, result.workflow)

  return res.json({
    workflow: result.workflow,
    summary: result.summary,
    nodes_used: result.nodes_used,
    validation,
    diff
  })
})

module.exports = router
```

- [ ] **Step 2: Verify the route manually by running all tests**

```bash
cd workflow-generator/server && npx jest --no-coverage
```

Expected: all existing tests still pass.

- [ ] **Step 3: Commit**

```bash
git add workflow-generator/server/routes/edit.js
git commit -m "feat: add POST /api/edit route with diff output"
```

---

### Task 10: n8n API Routes

**Files:**
- Create: `workflow-generator/server/routes/n8n.js`

Three endpoints: list workflows, run safe test, check test result.

- [ ] **Step 1: Implement n8n routes**

Create `workflow-generator/server/routes/n8n.js`:
```js
'use strict'

const { Router } = require('express')
const { createN8nClient } = require('../services/n8nClient')

const router = Router()

function getClient(req) {
  const { n8nUrl, n8nApiKey } = req.body || req.query
  if (!n8nUrl || !n8nApiKey) throw new Error('n8nUrl and n8nApiKey are required')
  return createN8nClient(n8nUrl, n8nApiKey)
}

// List workflows from a live n8n instance
router.post('/workflows', async (req, res) => {
  try {
    const client = getClient(req)
    const workflows = await client.listWorkflows()
    return res.json({ workflows: workflows.map(w => ({ id: w.id, name: w.name })) })
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }
})

// Get a single workflow by ID
router.post('/workflows/:id', async (req, res) => {
  try {
    const client = getClient(req)
    const workflow = await client.getWorkflow(req.params.id)
    return res.json({ workflow })
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }
})

// Safe test run: import as inactive, trigger, read result, return outcome
router.post('/test', async (req, res) => {
  const { n8nUrl, n8nApiKey, workflow } = req.body
  if (!n8nUrl || !n8nApiKey || !workflow) {
    return res.status(400).json({ error: 'n8nUrl, n8nApiKey, and workflow are required' })
  }

  const client = createN8nClient(n8nUrl, n8nApiKey)
  let importedId = null

  try {
    // Import as inactive
    const imported = await client.importWorkflow(workflow)
    importedId = imported.id

    // Trigger manual test
    let executionResult = null
    try {
      const exec = await client.triggerManualTest(importedId)
      executionResult = exec
    } catch (execErr) {
      return res.json({
        success: false,
        importedId,
        error: `Execution failed: ${execErr.message}`,
        message: 'The workflow was imported but the test execution failed.'
      })
    }

    return res.json({ success: true, importedId, execution: executionResult })
  } catch (err) {
    return res.status(500).json({ error: err.message, importedId })
  }
})

// Delete a previously imported test workflow
router.post('/delete', async (req, res) => {
  const { n8nUrl, n8nApiKey, workflowId } = req.body
  if (!n8nUrl || !n8nApiKey || !workflowId) {
    return res.status(400).json({ error: 'n8nUrl, n8nApiKey, and workflowId are required' })
  }
  try {
    const client = createN8nClient(n8nUrl, n8nApiKey)
    await client.deleteWorkflow(workflowId)
    return res.json({ deleted: true })
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }
})

module.exports = router
```

- [ ] **Step 2: Commit**

```bash
git add workflow-generator/server/routes/n8n.js
git commit -m "feat: add n8n API routes for workflow list, test run, and cleanup"
```

---

### Task 11: Express Entry Point

**Files:**
- Create: `workflow-generator/server/index.js`

- [ ] **Step 1: Create Express app**

Create `workflow-generator/server/index.js`:
```js
'use strict'

require('dotenv').config({ path: require('path').join(__dirname, '../.env') })

const express = require('express')
const cors = require('cors')
const path = require('path')

const generateRouter = require('./routes/generate')
const editRouter = require('./routes/edit')
const n8nRouter = require('./routes/n8n')

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

app.use('/api/generate', generateRouter)
app.use('/api/edit', editRouter)
app.use('/api/n8n', n8nRouter)

// Serve React build in production
const clientBuild = path.join(__dirname, '../client/dist')
app.use(express.static(clientBuild))
app.get('*', (req, res) => {
  res.sendFile(path.join(clientBuild, 'index.html'))
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`))

module.exports = app
```

- [ ] **Step 2: Run all server tests**

```bash
cd workflow-generator/server && npx jest --no-coverage
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add workflow-generator/server/index.js
git commit -m "feat: wire Express entry point with all routes and static serving"
```

---

### Task 12: React App Shell + Tailwind

**Files:**
- Create: `workflow-generator/client/src/main.jsx`
- Create: `workflow-generator/client/src/App.jsx`
- Create: `workflow-generator/client/src/index.css`
- Create: `workflow-generator/client/tailwind.config.js`
- Create: `workflow-generator/client/postcss.config.js`

- [ ] **Step 1: Configure Tailwind**

Create `workflow-generator/client/tailwind.config.js`:
```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: { extend: {} },
  plugins: []
}
```

Create `workflow-generator/client/postcss.config.js`:
```js
export default {
  plugins: { tailwindcss: {}, autoprefixer: {} }
}
```

- [ ] **Step 2: Create CSS entry**

Create `workflow-generator/client/src/index.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 3: Create React entry**

Create `workflow-generator/client/src/main.jsx`:
```jsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
```

- [ ] **Step 4: Create App shell**

Create `workflow-generator/client/src/App.jsx`:
```jsx
import { useState } from 'react'
import ModeTab from './components/ModeTab'
import BuildMode from './components/BuildMode'
import EditMode from './components/EditMode'
import WorkflowOutput from './components/WorkflowOutput'

export default function App() {
  const [mode, setMode] = useState('build') // 'build' | 'edit'
  const [result, setResult] = useState(null) // { workflow, summary, nodes_used, validation, diff? }
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  function handleResult(res) {
    setResult(res)
    setError(null)
  }

  function handleError(err) {
    setError(err)
    setResult(null)
  }

  function handleRefine() {
    setResult(null)
    setError(null)
  }

  return (
    <div className="min-h-screen bg-slate-50 font-sans">
      <header className="bg-white border-b border-slate-200 px-6 py-4">
        <h1 className="text-xl font-bold text-slate-800">n8n Workflow Generator</h1>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <ModeTab mode={mode} onChange={m => { setMode(m); setResult(null); setError(null) }} />

          <div className="p-6">
            {mode === 'build' ? (
              <BuildMode
                onResult={handleResult}
                onError={handleError}
                loading={loading}
                setLoading={setLoading}
              />
            ) : (
              <EditMode
                onResult={handleResult}
                onError={handleError}
                loading={loading}
                setLoading={setLoading}
              />
            )}

            {error && (
              <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {error}
              </div>
            )}

            {result && (
              <WorkflowOutput result={result} onRefine={handleRefine} />
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
```

- [ ] **Step 5: Commit**

```bash
git add workflow-generator/client/
git commit -m "feat: add React app shell with Tailwind CSS"
```

---

### Task 13: ModeTab Component

**Files:**
- Create: `workflow-generator/client/src/components/ModeTab.jsx`

- [ ] **Step 1: Create ModeTab**

Create `workflow-generator/client/src/components/ModeTab.jsx`:
```jsx
export default function ModeTab({ mode, onChange }) {
  const tabs = [
    { id: 'build', label: '✦ Build new workflow' },
    { id: 'edit', label: '✎ Edit existing workflow' }
  ]
  return (
    <div className="flex border-b border-slate-200 bg-slate-50">
      {tabs.map(tab => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`px-7 py-4 text-sm font-semibold transition-colors ${
            mode === tab.id
              ? 'text-indigo-600 border-b-2 border-indigo-600 -mb-px bg-white'
              : 'text-slate-400 hover:text-slate-600'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add workflow-generator/client/src/components/ModeTab.jsx
git commit -m "feat: add ModeTab component"
```

---

### Task 14: BuildMode Component + useWorkflow Hook

**Files:**
- Create: `workflow-generator/client/src/components/BuildMode.jsx`
- Create: `workflow-generator/client/src/hooks/useWorkflow.js`

- [ ] **Step 1: Create API hook**

Create `workflow-generator/client/src/hooks/useWorkflow.js`:
```js
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
```

- [ ] **Step 2: Create BuildMode component**

Create `workflow-generator/client/src/components/BuildMode.jsx`:
```jsx
import { useState } from 'react'
import { apiGenerate } from '../hooks/useWorkflow'

export default function BuildMode({ onResult, onError, loading, setLoading }) {
  const [description, setDescription] = useState('')

  async function handleGenerate() {
    if (!description.trim()) return
    setLoading(true)
    try {
      const result = await apiGenerate(description)
      onResult(result)
    } catch (err) {
      onError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
        Describe your workflow
      </label>
      <textarea
        className="w-full border-2 border-slate-200 rounded-xl p-4 text-sm leading-relaxed resize-none focus:outline-none focus:border-indigo-400 transition-colors"
        rows={5}
        placeholder={'e.g. "When someone submits a form on my site, send me a Slack message and add a row to my Google Sheet"'}
        value={description}
        onChange={e => setDescription(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) handleGenerate() }}
      />
      <div className="mt-3 flex items-center gap-4">
        <button
          onClick={handleGenerate}
          disabled={loading || !description.trim()}
          className="bg-indigo-600 text-white px-8 py-3 rounded-lg font-semibold text-sm hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? 'Generating…' : 'Generate workflow →'}
        </button>
        <span className="text-xs text-slate-400">⌘ + Enter to generate</span>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add workflow-generator/client/src/hooks/ workflow-generator/client/src/components/BuildMode.jsx
git commit -m "feat: add BuildMode component and useWorkflow API hooks"
```

---

### Task 15: EditMode Component

**Files:**
- Create: `workflow-generator/client/src/components/EditMode.jsx`

- [ ] **Step 1: Create EditMode component**

Create `workflow-generator/client/src/components/EditMode.jsx`:
```jsx
import { useState } from 'react'
import { apiEdit, apiListN8nWorkflows, apiGetN8nWorkflow } from '../hooks/useWorkflow'

export default function EditMode({ onResult, onError, loading, setLoading }) {
  const [source, setSource] = useState('upload') // 'upload' | 'connect'
  const [loadedWorkflow, setLoadedWorkflow] = useState(null)
  const [changeDescription, setChangeDescription] = useState('')
  const [n8nUrl, setN8nUrl] = useState('')
  const [n8nApiKey, setN8nApiKey] = useState('')
  const [workflowList, setWorkflowList] = useState(null)
  const [connectLoading, setConnectLoading] = useState(false)

  function handleFileUpload(e) {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = evt => {
      try {
        const parsed = JSON.parse(evt.target.result)
        setLoadedWorkflow(parsed)
      } catch {
        onError('Could not parse the uploaded file as JSON. Make sure it is a valid n8n workflow export.')
      }
    }
    reader.readAsText(file)
  }

  async function handleConnect() {
    if (!n8nUrl || !n8nApiKey) return
    setConnectLoading(true)
    try {
      const list = await apiListN8nWorkflows(n8nUrl, n8nApiKey)
      setWorkflowList(list)
    } catch (err) {
      onError(`Could not connect to n8n: ${err.message}`)
    } finally {
      setConnectLoading(false)
    }
  }

  async function handleSelectWorkflow(id) {
    setConnectLoading(true)
    try {
      const wf = await apiGetN8nWorkflow(n8nUrl, n8nApiKey, id)
      setLoadedWorkflow(wf)
      setWorkflowList(null)
    } catch (err) {
      onError(err.message)
    } finally {
      setConnectLoading(false)
    }
  }

  async function handleApply() {
    if (!loadedWorkflow || !changeDescription.trim()) return
    setLoading(true)
    try {
      const result = await apiEdit(loadedWorkflow, changeDescription)
      onResult(result)
    } catch (err) {
      onError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      {/* Source selector */}
      <div className="flex gap-3 mb-5">
        {[{ id: 'upload', label: '⬆ Upload .json file' }, { id: 'connect', label: '🔗 Connect to n8n' }].map(opt => (
          <button
            key={opt.id}
            onClick={() => { setSource(opt.id); setLoadedWorkflow(null); setWorkflowList(null) }}
            className={`flex-1 border-2 rounded-xl p-4 text-left transition-colors ${
              source === opt.id ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 bg-white hover:border-slate-300'
            }`}
          >
            <div className={`font-semibold text-sm ${source === opt.id ? 'text-indigo-700' : 'text-slate-700'}`}>{opt.label}</div>
          </button>
        ))}
      </div>

      {/* Upload source */}
      {source === 'upload' && !loadedWorkflow && (
        <label className="block border-2 border-dashed border-slate-300 rounded-xl p-8 text-center cursor-pointer hover:border-indigo-400 transition-colors mb-5">
          <div className="text-slate-500 text-sm">Drag & drop or <span className="text-indigo-600 font-semibold">browse</span></div>
          <input type="file" accept=".json" className="hidden" onChange={handleFileUpload} />
        </label>
      )}

      {/* Connect source */}
      {source === 'connect' && !loadedWorkflow && (
        <div className="mb-5 space-y-3">
          <input
            className="w-full border-2 border-slate-200 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-400"
            placeholder="n8n URL (e.g. http://localhost:5678)"
            value={n8nUrl}
            onChange={e => setN8nUrl(e.target.value)}
          />
          <input
            type="password"
            className="w-full border-2 border-slate-200 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-400"
            placeholder="n8n API key"
            value={n8nApiKey}
            onChange={e => setN8nApiKey(e.target.value)}
          />
          <button
            onClick={handleConnect}
            disabled={connectLoading || !n8nUrl || !n8nApiKey}
            className="bg-indigo-600 text-white px-6 py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50"
          >
            {connectLoading ? 'Connecting…' : 'Connect & list workflows'}
          </button>
          {workflowList && (
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              {workflowList.map(wf => (
                <button
                  key={wf.id}
                  onClick={() => handleSelectWorkflow(wf.id)}
                  className="w-full text-left px-4 py-3 text-sm text-slate-700 hover:bg-slate-50 border-b last:border-b-0 border-slate-100"
                >
                  {wf.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Loaded workflow badge */}
      {loadedWorkflow && (
        <div className="flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 mb-5">
          <span className="text-green-500 text-lg">✓</span>
          <div>
            <div className="font-semibold text-sm text-slate-700">{loadedWorkflow.name || 'Unnamed workflow'}</div>
            <div className="text-xs text-slate-400">{(loadedWorkflow.nodes || []).length} nodes</div>
          </div>
          <button onClick={() => setLoadedWorkflow(null)} className="ml-auto text-xs text-indigo-600 font-semibold">Change ×</button>
        </div>
      )}

      {/* Change description */}
      {loadedWorkflow && (
        <>
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
            What do you want to change?
          </label>
          <textarea
            className="w-full border-2 border-slate-200 rounded-xl p-4 text-sm leading-relaxed resize-none focus:outline-none focus:border-indigo-400 transition-colors"
            rows={4}
            placeholder={'e.g. "Add a Slack notification after the classifier step" or "Change the model to Haiku in all HTTP nodes"'}
            value={changeDescription}
            onChange={e => setChangeDescription(e.target.value)}
          />
          <button
            onClick={handleApply}
            disabled={loading || !changeDescription.trim()}
            className="mt-3 bg-indigo-600 text-white px-8 py-3 rounded-lg font-semibold text-sm hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Applying…' : 'Apply changes →'}
          </button>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add workflow-generator/client/src/components/EditMode.jsx
git commit -m "feat: add EditMode component with upload and live n8n connect"
```

---

### Task 16: WorkflowOutput, DiffView, and TestRunner Components

**Files:**
- Create: `workflow-generator/client/src/components/WorkflowOutput.jsx`
- Create: `workflow-generator/client/src/components/DiffView.jsx`
- Create: `workflow-generator/client/src/components/TestRunner.jsx`

- [ ] **Step 1: Create DiffView**

Create `workflow-generator/client/src/components/DiffView.jsx`:
```jsx
export default function DiffView({ diff }) {
  if (!diff) return null
  const { added = [], removed = [], connectionsAdded = [], connectionsRemoved = [] } = diff
  const hasChanges = added.length || removed.length || connectionsAdded.length || connectionsRemoved.length

  if (!hasChanges) return (
    <div className="text-sm text-slate-500 italic">No structural changes detected.</div>
  )

  return (
    <div className="font-mono text-xs space-y-1">
      {added.map(n => <div key={n} className="text-green-700">+ Added node: {n}</div>)}
      {removed.map(n => <div key={n} className="text-red-600">− Removed node: {n}</div>)}
      {connectionsAdded.map(c => <div key={c} className="text-green-700">+ Added connection: {c}</div>)}
      {connectionsRemoved.map(c => <div key={c} className="text-red-600">− Removed connection: {c}</div>)}
    </div>
  )
}
```

- [ ] **Step 2: Create TestRunner**

Create `workflow-generator/client/src/components/TestRunner.jsx`:
```jsx
import { useState } from 'react'
import { apiTestWorkflow, apiDeleteWorkflow } from '../hooks/useWorkflow'

export default function TestRunner({ workflow }) {
  const [show, setShow] = useState(false)
  const [n8nUrl, setN8nUrl] = useState('')
  const [n8nApiKey, setN8nApiKey] = useState('')
  const [testResult, setTestResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleted, setDeleted] = useState(false)

  async function handleTest() {
    if (!n8nUrl || !n8nApiKey) return
    setLoading(true)
    setTestResult(null)
    try {
      const result = await apiTestWorkflow(n8nUrl, n8nApiKey, workflow)
      setTestResult(result)
    } catch (err) {
      setTestResult({ success: false, error: err.message })
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete() {
    if (!testResult?.importedId) return
    setDeleteLoading(true)
    try {
      await apiDeleteWorkflow(n8nUrl, n8nApiKey, testResult.importedId)
      setDeleted(true)
    } catch (err) {
      alert(`Delete failed: ${err.message}`)
    } finally {
      setDeleteLoading(false)
    }
  }

  if (!show) {
    return (
      <button
        onClick={() => setShow(true)}
        className="bg-white text-slate-700 border border-slate-200 px-6 py-2.5 rounded-lg text-sm font-semibold hover:border-slate-300 transition-colors"
      >
        ▶ Test in n8n
      </button>
    )
  }

  return (
    <div className="mt-4 border border-slate-200 rounded-xl overflow-hidden">
      <div className="bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700 border-b border-slate-200">
        Safe test run — imports as inactive, no live webhooks fire
      </div>
      <div className="p-4 space-y-3">
        <input
          className="w-full border-2 border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
          placeholder="n8n URL (e.g. http://localhost:5678)"
          value={n8nUrl}
          onChange={e => setN8nUrl(e.target.value)}
        />
        <input
          type="password"
          className="w-full border-2 border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
          placeholder="n8n API key"
          value={n8nApiKey}
          onChange={e => setN8nApiKey(e.target.value)}
        />
        <button
          onClick={handleTest}
          disabled={loading || !n8nUrl || !n8nApiKey}
          className="bg-indigo-600 text-white px-6 py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50"
        >
          {loading ? 'Running test…' : 'Run test'}
        </button>

        {testResult && !deleted && (
          <div className={`rounded-lg p-4 text-sm ${testResult.success ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
            <div className={`font-semibold mb-1 ${testResult.success ? 'text-green-700' : 'text-red-700'}`}>
              {testResult.success ? '✓ Test passed' : '✗ Test failed'}
            </div>
            {testResult.error && <div className="text-red-600 text-xs">{testResult.error}</div>}
            {testResult.importedId && (
              <div className="mt-3 flex gap-2">
                <button
                  onClick={handleDelete}
                  disabled={deleteLoading}
                  className="text-xs bg-white border border-slate-200 px-3 py-1.5 rounded font-semibold text-slate-600 hover:border-red-300 hover:text-red-600"
                >
                  {deleteLoading ? 'Deleting…' : 'Delete test import'}
                </button>
                <span className="text-xs text-slate-400 self-center">or keep it in n8n</span>
              </div>
            )}
          </div>
        )}

        {deleted && (
          <div className="text-sm text-slate-500">Test workflow deleted from n8n.</div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Create WorkflowOutput**

Create `workflow-generator/client/src/components/WorkflowOutput.jsx`:
```jsx
import DiffView from './DiffView'
import TestRunner from './TestRunner'

export default function WorkflowOutput({ result, onRefine }) {
  const { workflow, summary, nodes_used = [], validation, diff } = result

  function handleDownload() {
    const blob = new Blob([JSON.stringify(workflow, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(workflow.name || 'workflow').replace(/\s+/g, '_')}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="mt-6 border border-slate-200 rounded-xl overflow-hidden">
      <div className="bg-slate-50 px-5 py-3 border-b border-slate-200 flex items-center gap-2">
        <span className="text-green-500 font-bold">✓</span>
        <span className="text-sm font-semibold text-slate-700">
          {diff ? 'Changes applied & validated' : 'Workflow generated & validated'}
        </span>
      </div>

      <div className="p-5 space-y-4">
        {/* Intent summary */}
        <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-800 leading-relaxed">
          <span className="font-semibold">What this does: </span>{summary}
        </div>

        {/* Validation badges */}
        <div className="flex gap-2 flex-wrap">
          <span className="bg-green-100 text-green-700 text-xs font-semibold px-3 py-1 rounded-full">✓ Schema valid</span>
          <span className="bg-blue-100 text-blue-700 text-xs font-semibold px-3 py-1 rounded-full">
            {(workflow.nodes || []).length} nodes
          </span>
          {nodes_used.length > 0 && (
            <span className="bg-slate-100 text-slate-600 text-xs font-semibold px-3 py-1 rounded-full">
              {nodes_used.join(', ')}
            </span>
          )}
        </div>

        {/* Diff (edit mode only) */}
        {diff && (
          <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">What changed</div>
            <DiffView diff={diff} />
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 flex-wrap">
          <button
            onClick={handleDownload}
            className="bg-indigo-600 text-white px-6 py-2.5 rounded-lg text-sm font-semibold hover:bg-indigo-700 transition-colors"
          >
            ⬇ Download .json
          </button>
          <TestRunner workflow={workflow} />
          <button
            onClick={onRefine}
            className="bg-white text-slate-700 border border-slate-200 px-6 py-2.5 rounded-lg text-sm font-semibold hover:border-slate-300 transition-colors"
          >
            ✎ Refine
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Commit**

```bash
git add workflow-generator/client/src/components/
git commit -m "feat: add WorkflowOutput, DiffView, and TestRunner components"
```

---

### Task 17: End-to-End Smoke Test

Start both servers, open the app, and verify the golden paths work end-to-end.

- [ ] **Step 1: Start dev servers**

```bash
cd workflow-generator
# Terminal 1:
cd server && node index.js
# Terminal 2:
cd client && npm run dev
```

Open http://localhost:5173

- [ ] **Step 2: Test Build mode**

1. Type: `"When a webhook is called, log the request body using a Code node and respond with 200 OK"`
2. Click **Generate workflow →**
3. Verify: summary appears, validation badge shows ✓ Schema valid
4. Click **⬇ Download .json**
5. Import the downloaded file into n8n — verify it imports without errors

- [ ] **Step 3: Test Edit mode (upload)**

1. Switch to **Edit existing workflow** tab
2. Upload one of the existing AG_ workflow files from this repo
3. Type: `"Add a No Operation node at the end"`
4. Click **Apply changes →**
5. Verify: diff shows `+ Added node: No Operation`, download works

- [ ] **Step 4: Test validation error display**

1. In Build mode, type: `"just a code node, no trigger"`
2. Verify: the app retries, and if it still fails, shows a validation error message (not a raw stack trace)

- [ ] **Step 5: Run all server tests one final time**

```bash
cd workflow-generator/server && npx jest --no-coverage
```

Expected: all tests pass.

- [ ] **Step 6: Final commit**

```bash
git add workflow-generator/
git commit -m "feat: complete n8n workflow generator — build, edit, validate, test"
```

---

## Summary

17 tasks, ~40 minutes of focused work. Each task ends in a passing test and a commit.

**Run order matters:** Tasks 1–7 are pure backend (scaffold → schema → services → routes). Tasks 8–16 are frontend. Task 17 is smoke testing.

**To start:**
```bash
cd workflow-generator
cp .env.example .env  # add your ANTHROPIC_API_KEY
npm install
```

**To run tests:**
```bash
cd workflow-generator/server && npx jest
```

**To run dev:**
```bash
cd workflow-generator
npm run dev
```
