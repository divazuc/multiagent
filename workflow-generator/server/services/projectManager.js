'use strict'

const fs = require('fs')
const path = require('path')

const PROJECTS_DIR = path.join(__dirname, '../../projects')
const GLOBAL_DIR = path.join(PROJECTS_DIR, '_global')

/**
 * Read a file safely — returns null if not found.
 */
function readFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf8') } catch { return null }
}

/**
 * Load global guidelines and credential map.
 */
function loadGlobalContext() {
  const guidelines = readFile(path.join(GLOBAL_DIR, 'guidelines.md')) || ''
  const credentialMap = readFile(path.join(GLOBAL_DIR, 'credential-map.md')) || ''
  return { guidelines, credentialMap }
}

/**
 * List all projects (subdirectories of projects/ excluding _global).
 */
function listProjects() {
  if (!fs.existsSync(PROJECTS_DIR)) return []
  return fs.readdirSync(PROJECTS_DIR)
    .filter(name => name !== '_global' && fs.statSync(path.join(PROJECTS_DIR, name)).isDirectory())
    .map(slug => {
      const manifest = loadManifest(slug)
      return { slug, name: manifest?.name || slug, workflowCount: manifest?.workflows?.length || 0 }
    })
}

/**
 * Scaffold a new project folder.
 */
function createProject(slug) {
  const projectDir = path.join(PROJECTS_DIR, slug)
  const workflowsDir = path.join(projectDir, 'workflows')
  if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true })
  if (!fs.existsSync(workflowsDir)) fs.mkdirSync(workflowsDir)
  return projectDir
}

/**
 * Save spec.md for a project.
 */
function saveSpec(slug, specContent) {
  createProject(slug)
  fs.writeFileSync(path.join(PROJECTS_DIR, slug, 'spec.md'), specContent, 'utf8')
}

/**
 * Load manifest.json for a project.
 */
function loadManifest(slug) {
  const p = path.join(PROJECTS_DIR, slug, 'manifest.json')
  if (!fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

/**
 * Save manifest.json for a project.
 */
function saveManifest(slug, manifest) {
  createProject(slug)
  fs.writeFileSync(
    path.join(PROJECTS_DIR, slug, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  )
}

/**
 * Save a workflow JSON file into the project's workflows/ folder.
 */
function saveWorkflow(slug, workflowName, workflowJson) {
  const dir = path.join(PROJECTS_DIR, slug, 'workflows')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const fileName = workflowName.replace(/[^a-z0-9]+/gi, '_').toLowerCase() + '.json'
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(workflowJson, null, 2), 'utf8')
  return fileName
}

/**
 * Load a single workflow JSON file from a project's workflows/ folder.
 * Uses the same filename convention as saveWorkflow.
 */
function loadWorkflow(slug, workflowName) {
  const fileName = workflowName.replace(/[^a-z0-9]+/gi, '_').toLowerCase() + '.json'
  const p = path.join(PROJECTS_DIR, slug, 'workflows', fileName)
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

/**
 * Load full project context for injection into Claude prompts.
 */
function loadProjectContext(slug) {
  const global = loadGlobalContext()
  const spec = readFile(path.join(PROJECTS_DIR, slug, 'spec.md')) || ''
  const guidelines = readFile(path.join(PROJECTS_DIR, slug, 'guidelines.md')) || ''
  const manifest = loadManifest(slug)
  return { global, spec, guidelines, manifest }
}

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
    lines.join('\n') + '\n',
    'utf8'
  )
}

/**
 * Load spec.md for a project.
 */
function loadSpec(slug) {
  return readFile(path.join(PROJECTS_DIR, slug, 'spec.md')) || ''
}

/**
 * Load conversation log for a project.
 */
function loadConversation(slug) {
  const p = path.join(PROJECTS_DIR, slug, 'conversation.json')
  if (!fs.existsSync(p)) return []
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return [] }
}

/**
 * Append an entry to the conversation log and return the full updated log.
 * entry: { at: ISO string, request: string, updated: string[] }
 */
function appendConversation(slug, entry) {
  const existing = loadConversation(slug)
  const updated = [...existing, entry]
  fs.writeFileSync(
    path.join(PROJECTS_DIR, slug, 'conversation.json'),
    JSON.stringify(updated, null, 2),
    'utf8'
  )
  return updated
}

module.exports = {
  listProjects,
  createProject,
  saveSpec,
  loadSpec,
  loadManifest,
  saveManifest,
  saveWorkflow,
  loadWorkflow,
  loadProjectContext,
  loadGlobalContext,
  savePendingInfo,
  loadConversation,
  appendConversation,
  PROJECTS_DIR
}
