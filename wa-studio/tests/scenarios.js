/**
 * Test scenarios for the WA Sales Agent.
 *
 * Each scenario is { name, description, run(ctx) }.
 * ctx = { send, assert, assertBody, supabase, createTestSession, createTestBusiness, seedKnowledgeItems, seedBusinessProfile, cleanup }
 * Throw to fail. Return an optional { note } string for extra context.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. SETUP FLOW — routing reaches WA_04
// ─────────────────────────────────────────────────────────────────────────────
export const setupRouting = {
  name: 'setup / routing',
  description: 'A message to a setup session is handled (no error, status success)',
  async run({ send, assert, createTestSession, cleanup }) {
    const session = await createTestSession('setup')
    try {
      const { ok, body } = await send(session.session_id, 'שלום, אני מנהל סטודיו יוגה')
      assert(ok, `HTTP error — status not ok. body: ${JSON.stringify(body)}`)
      assert(body.status !== 'error', `Response is error: ${body.message}`)
      assert(body.message && body.message.length > 0, 'Empty message in response')
    } finally {
      await cleanup([session.session_id])
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. SETUP FLOW — approval at confirm_and_commit returns action:commit
// ─────────────────────────────────────────────────────────────────────────────
export const setupCommit = {
  name: 'setup / commit on approval',
  description: 'Sending מאשר at confirm_and_commit stage returns action:commit',
  async run({ send, assert, assertBody, supabase, createTestBusiness, cleanup }) {
    const biz = await createTestBusiness('Test Commit Biz')
    // Create session already at confirm stage
    const sessionId = `test_commit_${Date.now()}`
    await supabase.from('sessions').upsert({
      session_id: sessionId,
      session_mode: 'setup',
      business_id: biz.id,
      setup_completed: false,
      current_stage: 'confirm_and_commit',
      current_setup_stage: 'confirm_and_commit',
    }, { onConflict: 'session_id' })
    // Seed draft so WA_04 has something to show
    await supabase.from('setup_drafts').upsert({
      session_id: sessionId,
      business_id: biz.id,
      current_setup_stage: 'confirm_and_commit',
      setup_completed: false,
      draft_setup_data: {
        archetype: 'service',
        collect_business_model: 'service',
        service_collect_offerings: ['ייעוץ עסקי'],
        collect_sales_goal: { sales_goal: 'ייצור לידים' },
        collect_persona: { name: 'עוזר חברותי', tone: 'friendly' },
        guardrails: { avoid: [] },
      },
    }, { onConflict: 'session_id' })

    try {
      const { ok, body } = await send(sessionId, 'מאשר', biz.id)
      assert(ok, `HTTP error. body: ${JSON.stringify(body)}`)
      assertBody(body, { status: 'success' })
      assert(
        body.result?.action === 'commit',
        `Expected action:commit, got: ${JSON.stringify(body.result?.action)}. message: ${body.message}`
      )
    } finally {
      await cleanup([sessionId], [biz.id])
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. ONBOARDING — first question auto-loads for fresh learning session
// ─────────────────────────────────────────────────────────────────────────────
export const onboardingFirstQuestion = {
  name: 'onboarding / first question',
  description: 'Fresh learning session with pending FAQ items returns first question with 📌',
  async run({ send, assert, createTestSession, createTestBusiness, seedKnowledgeItems, cleanup }) {
    const biz = await createTestBusiness('Test Onboarding Biz')
    await seedKnowledgeItems(biz.id, [
      { category: 'general', question: 'איך התהליך עובד?', answer: '' },
      { category: 'booking', question: 'מתי אפשר להתחיל?', answer: '' },
    ])
    const session = await createTestSession('learning', biz.id)
    try {
      const { ok, body } = await send(session.session_id, 'start', biz.id)
      assert(ok, `HTTP error. body: ${JSON.stringify(body)}`)
      assert(body.status !== 'error', `Error response: ${body.message}`)
      assert(body.message?.includes('📌'), `Expected 📌 in message, got: ${body.message}`)
      assert(body.message?.includes('איך התהליך עובד'), `Expected first question in message, got: ${body.message}`)
    } finally {
      await cleanup([session.session_id], [biz.id])
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. ONBOARDING — answering saves to DB and asks next question
// ─────────────────────────────────────────────────────────────────────────────
export const onboardingSaveAndAsk = {
  name: 'onboarding / save answer and ask next',
  description: 'Answering Q1 saves it as is_active=true and response contains Q2',
  async run({ send, assert, supabase, createTestSession, createTestBusiness, seedKnowledgeItems, cleanup }) {
    const biz = await createTestBusiness('Test Onboarding Save Biz')
    await seedKnowledgeItems(biz.id, [
      { category: 'general', question: 'שאלה ראשונה?', answer: '' },
      { category: 'general', question: 'שאלה שניה?',  answer: '' },
    ])
    const session = await createTestSession('learning', biz.id)

    // Turn 1: get first question (answered_count=0)
    await send(session.session_id, 'start', biz.id)

    // Turn 2: answer it (answered_count=0 still, so this saves Q1)
    const answer = 'התהליך לוקח כשבועיים'
    const { ok, body } = await send(session.session_id, answer, biz.id)
    assert(ok, `HTTP error. body: ${JSON.stringify(body)}`)
    assert(body.message?.includes('📌'), `Expected next question with 📌, got: ${body.message}`)
    assert(body.message?.includes('שאלה שניה'), `Expected Q2 in response, got: ${body.message}`)

    // Verify DB: Q1 should now be is_active=true
    const { data: items } = await supabase
      .from('knowledge_items')
      .select('question, answer, is_active')
      .eq('business_id', biz.id)
      .eq('is_active', true)
    assert(items?.length === 1, `Expected 1 active item, got ${items?.length}`)
    assert(items[0].answer === answer, `Expected answer "${answer}", got "${items[0].answer}"`)

    await cleanup([session.session_id], [biz.id])
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. ONBOARDING — all questions answered → done message
// ─────────────────────────────────────────────────────────────────────────────
export const onboardingDone = {
  name: 'onboarding / all done',
  description: 'Answering last question returns the all-done celebration message',
  async run({ send, assert, createTestSession, createTestBusiness, seedKnowledgeItems, cleanup }) {
    const biz = await createTestBusiness('Test Onboarding Done Biz')
    await seedKnowledgeItems(biz.id, [
      { category: 'general', question: 'שאלה יחידה?', answer: '' },
    ])
    const session = await createTestSession('learning', biz.id)

    // Turn 1: first question
    await send(session.session_id, 'start', biz.id)
    // Turn 2: answer the only question
    const { ok, body } = await send(session.session_id, 'תשובה לשאלה היחידה', biz.id)

    assert(ok, `HTTP error. body: ${JSON.stringify(body)}`)
    assert(body.message?.includes('🎉'), `Expected 🎉 done message, got: ${body.message}`)

    await cleanup([session.session_id], [biz.id])
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. LIVE MODE — customer message returns non-error response
// ─────────────────────────────────────────────────────────────────────────────
export const liveResponse = {
  name: 'live / customer message handled',
  description: 'Live session returns a non-empty success response to a customer message',
  async run({ send, assert, supabase, createTestSession, createTestBusiness, seedBusinessProfile, cleanup }) {
    const biz = await createTestBusiness('Test Live Biz')
    const session = await createTestSession('live', biz.id)
    await seedBusinessProfile(biz.id, session.session_id)

    try {
      const { ok, body } = await send(session.session_id, 'שלום, אני מעוניין בשירות שלכם', biz.id)
      assert(ok, `HTTP error. body: ${JSON.stringify(body)}`)
      assert(body.status !== 'error', `Error response: ${body.message}`)
      assert(body.message && body.message.length > 5, `Empty/short response: ${body.message}`)
    } finally {
      await cleanup([session.session_id], [biz.id])
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. LIVE MODE — FAQ injection (active knowledge item appears in response)
// ─────────────────────────────────────────────────────────────────────────────
export const liveFaqInjection = {
  name: 'live / FAQ injected into response',
  description: 'Customer asks a question covered by an active FAQ item — agent responds (no error)',
  async run({ send, assert, supabase, createTestSession, createTestBusiness, seedBusinessProfile, seedKnowledgeItems, cleanup }) {
    const biz = await createTestBusiness('Test Live FAQ Biz')
    const session = await createTestSession('live', biz.id)
    await seedBusinessProfile(biz.id, session.session_id)
    await seedKnowledgeItems(biz.id, [
      { category: 'booking', question: 'מתי אפשר להתחיל?', answer: 'ניתן להתחיל בתיאום מוקדם של 48 שעות.', is_active: true },
    ])

    try {
      const { ok, body } = await send(session.session_id, 'מתי אפשר להתחיל לעבוד איתכם?', biz.id)
      assert(ok, `HTTP error. body: ${JSON.stringify(body)}`)
      assert(body.status !== 'error', `Error response: ${body.message}`)
      assert(body.message && body.message.length > 5, `Empty response: ${body.message}`)
      return { note: `Agent said: "${body.message?.slice(0, 120)}…"` }
    } finally {
      await cleanup([session.session_id], [biz.id])
    }
  },
}

export const ALL_SCENARIOS = [
  setupRouting,
  setupCommit,
  onboardingFirstQuestion,
  onboardingSaveAndAsk,
  onboardingDone,
  liveResponse,
  liveFaqInjection,
]
