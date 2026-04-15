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
