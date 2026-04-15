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
