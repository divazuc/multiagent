#!/usr/bin/env node
/**
 * WA Sales Agent — Test Runner
 *
 * Usage:
 *   node tests/run.js              # run all scenarios
 *   node tests/run.js setup        # run scenarios whose name contains "setup"
 *   node tests/run.js onboarding   # run onboarding scenarios only
 *
 * Autoresearch pattern: fixed budget (30s per scenario) + single pass/fail metric.
 * Run after every n8n change to catch regressions before manual testing.
 */

import { ALL_SCENARIOS } from './scenarios.js'
import {
  send, assert, assertBody, supabase,
  createTestSession, createTestBusiness,
  seedKnowledgeItems, seedBusinessProfile,
  cleanup, WEBHOOK_URL,
} from './helpers.js'

const TIMEOUT_MS = 35_000
const filter = process.argv[2]?.toLowerCase()

// ── Runner ────────────────────────────────────────────────────────────────────

const ctx = { send, assert, assertBody, supabase, createTestSession, createTestBusiness, seedKnowledgeItems, seedBusinessProfile, cleanup }

const scenarios = filter
  ? ALL_SCENARIOS.filter(s => s.name.toLowerCase().includes(filter))
  : ALL_SCENARIOS

if (scenarios.length === 0) {
  console.error(`No scenarios match "${filter}"`)
  process.exit(1)
}

const pad = (s, n) => s.padEnd(n)
const W = 42

console.log()
console.log(`  WA Agent Test Suite  —  ${WEBHOOK_URL}`)
console.log(`  ${scenarios.length} scenario${scenarios.length !== 1 ? 's' : ''}${filter ? ` (filter: "${filter}")` : ''}`)
console.log()

let passed = 0
let failed = 0
const results = []
const start = Date.now()

for (const scenario of scenarios) {
  const t0 = Date.now()
  let status = 'PASS'
  let note = ''

  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)
  )

  try {
    const result = await Promise.race([scenario.run(ctx), timer])
    if (result?.note) note = result.note
    passed++
  } catch (e) {
    status = 'FAIL'
    note = e.message
    failed++
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1) + 's'
  const icon = status === 'PASS' ? '✓' : '✗'
  const line = `  ${icon}  ${pad(scenario.name, W)}  ${elapsed.padStart(6)}${note ? `\n       ${note}` : ''}`
  console.log(status === 'PASS' ? line : line)
  results.push({ scenario, status, note, elapsed })
}

const total = ((Date.now() - start) / 1000).toFixed(1)
console.log()
console.log(`  ${passed}/${scenarios.length} passed  (${total}s total)`)
console.log()

if (failed > 0) {
  console.log('  Failed:')
  for (const r of results.filter(r => r.status === 'FAIL')) {
    console.log(`    ✗  ${r.scenario.name}`)
    console.log(`       ${r.note}`)
  }
  console.log()
  process.exit(1)
}
