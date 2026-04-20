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

// ─────────────────────────────────────────────────────────────────────────────
// 8. SETUP FLOW — studio exit stage advances to shared tail
//
// Verifies the last studio-specific stage (studio_collect_booking) exits into
// the shared tail (collect_sales_goal). Uses either a natural save_draft on the
// first clear answer, or the turn-3 force-advance if the AI clarifies. Draft is
// pre-populated with classes + pricing so the AI focuses on booking only.
// ─────────────────────────────────────────────────────────────────────────────
export const setupStudioPath = {
  name: 'setup / studio exit stage → shared tail',
  description: 'studio_collect_booking advances to collect_sales_goal (tolerant of clarify + turn-3 force)',
  async run({ send, assert, supabase, createTestBusiness, cleanup }) {
    const biz = await createTestBusiness('Test Studio Exit Biz')
    const sessionId = `test_studio_exit_${Date.now()}`
    const stage = 'studio_collect_booking'

    await supabase.from('sessions').upsert({
      session_id: sessionId,
      session_mode: 'setup',
      business_id: biz.id,
      setup_completed: false,
      current_stage: stage,
      current_setup_stage: stage,
    }, { onConflict: 'session_id' })
    await supabase.from('setup_drafts').upsert({
      session_id: sessionId,
      business_id: biz.id,
      current_setup_stage: stage,
      setup_completed: false,
      draft_setup_data: {
        archetype: 'studio',
        collect_business_model: 'studio',
        studio_collect_classes: { classes: ['יוגה', 'פילאטיס'], schedule: 'בוקר וערב' },
        studio_collect_pricing: { subscription: '350₪/חודש', single: '50₪' },
      },
    }, { onConflict: 'session_id' })

    async function readState() {
      const [{ data: draft }, { data: session }] = await Promise.all([
        supabase.from('setup_drafts').select('draft_setup_data, current_setup_stage').eq('session_id', sessionId).single(),
        supabase.from('sessions').select('current_setup_stage').eq('session_id', sessionId).single(),
      ])
      return {
        turns: draft?.draft_setup_data?.[`${stage}_turns`] || 0,
        draftStage: draft?.current_setup_stage,
        sessionStage: session?.current_setup_stage,
      }
    }

    try {
      const answers = [
        'הרשמה דרך וואטסאפ, ביטול חינם עד 12 שעות לפני, תשלום במזומן או באפליקציה, מתקבלים לקוחות חדשים ללא הרשמה מוקדמת.',
        'וואטסאפ, ביטול 12 שעות, מזומן או אפליקציה.',
        'וואטסאפ, ביטול 12 שעות.',
      ]
      let advanced = false
      let lastAction = null
      let turnsUsed = 0
      let finalSessionStage = null
      for (let i = 0; i < 3; i++) {
        const r = await send(sessionId, answers[i], biz.id)
        assert(r.ok, `turn${i + 1} HTTP error. body: ${JSON.stringify(r.body)}`)
        lastAction = r.body.result?.action
        const d = await readState()
        turnsUsed = d.turns
        finalSessionStage = d.sessionStage
        if (d.draftStage === 'collect_sales_goal') {
          advanced = true
          break
        }
      }
      assert(advanced,
        `studio_collect_booking never advanced to collect_sales_goal after 3 turns. lastAction=${lastAction} turns=${turnsUsed}`)
      assert(finalSessionStage === 'collect_sales_goal',
        `sessions.current_setup_stage should have advanced to collect_sales_goal, got: ${finalSessionStage}. WA_04 session-advance fix may be regressed.`)
      return { note: `advanced after ${turnsUsed} turn(s), lastAction=${lastAction}, sessions row advanced` }
    } finally {
      await cleanup([sessionId], [biz.id])
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. SETUP FLOW — clarification loop forces advance at turn 3
// ─────────────────────────────────────────────────────────────────────────────
export const setupClarificationLoop = {
  name: 'setup / clarification loop force-advance',
  description: 'Vague answers trigger clarify; turn 3 forces save_draft and advances',
  async run({ send, assert, supabase, createTestBusiness, cleanup }) {
    const biz = await createTestBusiness('Test Clarify Biz')
    const sessionId = `test_clarify_${Date.now()}`
    const stage = 'studio_collect_classes'
    await supabase.from('sessions').upsert({
      session_id: sessionId,
      session_mode: 'setup',
      business_id: biz.id,
      setup_completed: false,
      current_stage: stage,
      current_setup_stage: stage,
    }, { onConflict: 'session_id' })
    await supabase.from('setup_drafts').upsert({
      session_id: sessionId,
      business_id: biz.id,
      current_setup_stage: stage,
      setup_completed: false,
      draft_setup_data: { archetype: 'studio', collect_business_model: 'studio' },
    }, { onConflict: 'session_id' })

    async function readState() {
      const [{ data: draft }, { data: session }] = await Promise.all([
        supabase.from('setup_drafts').select('draft_setup_data, current_setup_stage').eq('session_id', sessionId).single(),
        supabase.from('sessions').select('current_setup_stage').eq('session_id', sessionId).single(),
      ])
      return {
        turns: draft?.draft_setup_data?.[`${stage}_turns`] || 0,
        draftStage: draft?.current_setup_stage,
        sessionStage: session?.current_setup_stage,
      }
    }

    try {
      // Turn 1: vague — expect clarify
      const r1 = await send(sessionId, 'לא יודע', biz.id)
      assert(r1.ok, `turn1 HTTP error. body: ${JSON.stringify(r1.body)}`)
      const act1 = r1.body.result?.action
      const s1 = await readState()
      assert(s1.turns >= 1, `expected turns>=1 after turn 1, got: ${s1.turns}, action=${act1}`)

      // Turn 2: vague again
      const r2 = await send(sessionId, 'אולי', biz.id)
      assert(r2.ok, `turn2 HTTP error. body: ${JSON.stringify(r2.body)}`)
      const act2 = r2.body.result?.action
      const s2 = await readState()
      assert(s2.turns >= 2, `expected turns>=2 after turn 2, got: ${s2.turns}, action=${act2}`)

      // Turn 3: vague → WA_04 forces save_draft (Build draft: turns>=3 && action==clarify → save_draft)
      // This advances setup_drafts.current_setup_stage AND sessions.current_setup_stage to studio_collect_pricing.
      const r3 = await send(sessionId, 'תשובה כללית', biz.id)
      assert(r3.ok, `turn3 HTTP error. body: ${JSON.stringify(r3.body)}`)
      const act3 = r3.body.result?.action
      const next3 = r3.body.result?.next_setup_stage
      const s3 = await readState()
      assert(act3 === 'save_draft',
        `expected action=save_draft at turn 3, got action=${act3} next=${next3}`)
      assert(s3.draftStage === 'studio_collect_pricing',
        `expected draft to advance to studio_collect_pricing at turn 3, got draftStage=${s3.draftStage} turns=${s3.turns} action=${act3}`)
      assert(s3.sessionStage === 'studio_collect_pricing',
        `expected sessions.current_setup_stage to advance, got: ${s3.sessionStage}. WA_04 session-advance fix may be regressed.`)

      return { note: `actions: t1=${act1} t2=${act2} t3=${act3}, turns=${s3.turns}, both draft+session advanced to ${s3.draftStage}` }
    } finally {
      await cleanup([sessionId], [biz.id])
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. LIVE MODE — save pipeline writes to conversation_messages + prod_* + contacts
// ─────────────────────────────────────────────────────────────────────────────
export const liveSavePipeline = {
  name: 'live / save pipeline writes all tables',
  description: 'Live turn populates conversation_messages, contacts, prod_conversations, prod_messages (2 rows per turn) and reuses the same conversation across turns',
  async run({ send, assert, supabase, createTestBusiness, seedBusinessProfile, cleanup }) {
    const biz = await createTestBusiness('Test Save Pipeline')
    const sessionId = `test_save_${Date.now()}`
    await supabase.from('sessions').upsert({
      session_id: sessionId, session_mode: 'live', business_id: biz.id,
      setup_completed: true, current_stage: 'start',
    }, { onConflict: 'session_id' })
    await seedBusinessProfile(biz.id, sessionId)

    try {
      // Turn 1
      const r1 = await send(sessionId, 'שלום, מה השירותים שלכם?', biz.id)
      assert(r1.ok, `turn1 HTTP. body: ${JSON.stringify(r1.body)}`)
      // Postgres writes are async to webhook response — small buffer
      await new Promise(r => setTimeout(r, 1200))

      const cm1 = await supabase.from('conversation_messages').select('user_message, agent_response').eq('session_id', sessionId)
      assert(cm1.data?.length === 1, `expected 1 conversation_messages row, got ${cm1.data?.length}`)
      const c1 = await supabase.from('contacts').select('phone').eq('business_id', biz.id)
      assert(c1.data?.length === 1, `expected 1 contacts row, got ${c1.data?.length}`)
      const pc1 = await supabase.from('prod_conversations').select('id, status').eq('business_id', biz.id)
      assert(pc1.data?.length === 1, `expected 1 prod_conversations row, got ${pc1.data?.length}`)
      assert(pc1.data[0].status === 'open', `expected status=open, got ${pc1.data[0].status}`)
      const pm1 = await supabase.from('prod_messages').select('direction, sender_type, message_text').eq('conversation_id', pc1.data[0].id)
      assert(pm1.data?.length === 2, `expected 2 prod_messages rows (user+assistant), got ${pm1.data?.length}`)
      assert(pm1.data.some(m => m.direction === 'inbound' && m.sender_type === 'user'), 'missing inbound/user row')
      assert(pm1.data.some(m => m.direction === 'outbound' && m.sender_type === 'assistant'), 'missing outbound/assistant row')

      // Turn 2 — conversation must be reused, message count doubles
      const r2 = await send(sessionId, 'איפה אתם נמצאים?', biz.id)
      assert(r2.ok, `turn2 HTTP. body: ${JSON.stringify(r2.body)}`)
      await new Promise(r => setTimeout(r, 1200))

      const pc2 = await supabase.from('prod_conversations').select('id').eq('business_id', biz.id)
      assert(pc2.data?.length === 1, `expected still 1 prod_conversations after turn 2, got ${pc2.data?.length}`)
      const pm2 = await supabase.from('prod_messages').select('id').eq('conversation_id', pc2.data[0].id)
      assert(pm2.data?.length === 4, `expected 4 prod_messages rows after turn 2, got ${pm2.data?.length}`)

      return { note: `turn1: 1 conv_msg + 2 prod_msg + 1 contact + 1 conv; turn2 reused conv → 4 prod_msg total` }
    } finally {
      // Extra cleanup beyond the standard helper — remove prod_* rows
      const pc = await supabase.from('prod_conversations').select('id').eq('business_id', biz.id)
      for (const conv of pc.data || []) await supabase.from('prod_messages').delete().eq('conversation_id', conv.id)
      await supabase.from('prod_conversations').delete().eq('business_id', biz.id)
      await supabase.from('contacts').delete().eq('business_id', biz.id)
      await cleanup([sessionId], [biz.id])
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
  setupStudioPath,
  setupClarificationLoop,
  liveSavePipeline,
]
