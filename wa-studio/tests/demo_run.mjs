// Autonomous demo-run: creates a test studio business, seeds profile + FAQ,
// runs a series of live customer messages, audits all DB tables afterwards.
//
// Usage: node tests/demo_run.mjs
//
// Outputs a JSON report to tests/demo_audit.json for the spec writer to consume.

import { supabase, createTestBusiness, seedKnowledgeItems, seedBusinessProfile, createTestSession, send, WEBHOOK_URL } from './helpers.js'
import { writeFileSync } from 'fs'

const LIVE_TURNS = [
  'שלום! ראיתי את הסטודיו שלכם',
  'כמה עולה שיעור יוגה?',
  'יש אפשרות לשיעור ניסיון?',
  'באיזה שעות אתם פתוחים?',
  'אני רוצה להירשם לכרטיסייה',
]

const LEARNING_TURNS = [
  'התהליך לוקח בערך שבועיים של עבודה משותפת עם כל לקוח',
  'מנוי חודשי של 350 שקל',
  'אפשר לתאם פגישת ייעוץ ראשונה בטלפון',
]

function log(tag, obj) {
  console.log(`[${tag}]`, typeof obj === 'string' ? obj : JSON.stringify(obj).slice(0, 200))
}

async function run() {
  const report = { started_at: new Date().toISOString(), steps: [], tables: {} }

  // ── Step 1: create business + session + profile + FAQ ──
  log('step1', 'creating demo studio business')
  const biz = await createTestBusiness('Demo Studio — ' + new Date().toISOString().slice(0, 19))
  // Mark as studio archetype
  await supabase.from('businesses').update({ archetype: 'studio' }).eq('id', biz.id)
  report.business_id = biz.id
  report.business_name = biz.name

  const sessionId = `demo_live_${Date.now()}`
  await supabase.from('sessions').upsert({
    session_id: sessionId,
    session_mode: 'live',
    business_id: biz.id,
    setup_completed: true,
    current_stage: 'start',
    current_setup_stage: null,
  }, { onConflict: 'session_id' })
  report.session_id = sessionId

  await seedBusinessProfile(biz.id, sessionId)
  // Override profile with studio-shaped content
  await supabase.from('business_profiles').update({
    business_model: '"studio"',
    sales_goal: 'רישום לשיעורים + מכירת מנויים',
    services: JSON.stringify([
      { name: 'שיעור יוגה', price: '50 ש"ח' },
      { name: 'מנוי חודשי', price: '350 ש"ח' },
      { name: 'כרטיסייה של 10', price: '900 ש"ח' },
    ]),
    persona: JSON.stringify({ name: 'מלווה הסטודיו', tone: 'warm', style: 'friendly' }),
  }).eq('business_id', biz.id)

  await seedKnowledgeItems(biz.id, [
    { category: 'pricing',  question: 'כמה עולה שיעור יוגה?',     answer: 'שיעור בודד 50 ש"ח. מנוי חודשי 350 ש"ח.' },
    { category: 'trial',    question: 'יש שיעור ניסיון?',           answer: 'כן! שיעור ניסיון ראשון חינם.' },
    { category: 'scheduling', question: 'מה שעות הפעילות?',         answer: 'ראשון-חמישי 7:00-21:00, שישי עד 13:00.' },
    { category: 'booking',  question: 'איך נרשמים לשיעור?',          answer: 'שולחים הודעה בווטסאפ או מתקשרים.' },
    { category: 'location', question: 'איפה אתם נמצאים?',            answer: 'רחוב הרצל 45, תל אביב.' },
  ])
  log('step1', { business_id: biz.id, session_id: sessionId })
  report.steps.push({ step: 'seed', ok: true })

  // ── Step 2: run live conversation turns ──
  log('step2', 'running live customer turns')
  for (let i = 0; i < LIVE_TURNS.length; i++) {
    const msg = LIVE_TURNS[i]
    const r = await send(sessionId, msg, biz.id)
    log(`live_turn_${i + 1}`, { ok: r.ok, status: r.body?.status, msg_preview: r.body?.message?.slice(0, 120) })
    report.steps.push({ step: `live_turn_${i + 1}`, user: msg, ok: r.ok, status: r.body?.status, reply: r.body?.message })
  }

  // ── Step 3: try a learning-mode (demo) session for contrast ──
  log('step3', 'running learning session turns')
  const learnSessionId = `demo_learn_${Date.now()}`
  await supabase.from('sessions').upsert({
    session_id: learnSessionId,
    session_mode: 'learning',
    business_id: biz.id,
    setup_completed: true,
    current_stage: 'start',
    current_setup_stage: null,
  }, { onConflict: 'session_id' })
  // Add a few unanswered FAQ items so onboarding has something to ask
  await supabase.from('knowledge_items').insert([
    { business_id: biz.id, category: 'general', question: 'כמה זמן לוקח לראות תוצאות?', answer: '', language: 'he', is_active: false },
    { business_id: biz.id, category: 'general', question: 'איזה רמות קושי יש?',           answer: '', language: 'he', is_active: false },
  ])
  const startRes = await send(learnSessionId, 'start', biz.id)
  log('learning_start', { ok: startRes.ok, reply: startRes.body?.message?.slice(0, 120) })
  for (let i = 0; i < LEARNING_TURNS.length; i++) {
    const r = await send(learnSessionId, LEARNING_TURNS[i], biz.id)
    log(`learning_turn_${i + 1}`, { ok: r.ok, reply: r.body?.message?.slice(0, 120) })
    report.steps.push({ step: `learning_turn_${i + 1}`, user: LEARNING_TURNS[i], ok: r.ok, reply: r.body?.message })
  }

  // ── Step 4: audit DB state ──
  log('step4', 'auditing DB tables')
  const schema1Tables = [
    'sessions', 'business_profiles', 'setup_drafts', 'conversation_messages',
    'knowledge_items',
  ]
  const schema2Tables = [
    'businesses', 'business_config', 'business_persona',
    'contacts', 'prod_conversations', 'prod_messages',
    'business_usage_daily', 'business_usage_monthly',
    'external_leads_sources', 'admin_sessions',
  ]

  async function countFor(table, column, value) {
    const { count, error } = await supabase.from(table).select('id', { count: 'exact', head: true }).eq(column, value)
    return error ? { error: error.message } : { count }
  }

  // Global count + demo-business-specific count where applicable
  for (const t of [...schema1Tables, ...schema2Tables]) {
    const g = await supabase.from(t).select('*', { count: 'exact', head: true })
    const cell = { global_count: g.error ? `err:${g.error.message}` : g.count }
    if (['knowledge_items', 'business_profiles', 'business_config', 'business_persona', 'contacts', 'prod_conversations', 'prod_messages', 'business_usage_daily', 'business_usage_monthly', 'external_leads_sources', 'admin_sessions'].includes(t)) {
      const d = await countFor(t, 'business_id', biz.id)
      cell.demo_business = d
    }
    if (['sessions', 'conversation_messages', 'setup_drafts'].includes(t)) {
      const session1 = await countFor(t, 'session_id', sessionId)
      const session2 = await countFor(t, 'session_id', learnSessionId)
      cell.demo_live_session = session1
      cell.demo_learning_session = session2
    }
    if (t === 'businesses') {
      const d = await countFor(t, 'id', biz.id)
      cell.demo_business = d
    }
    report.tables[t] = cell
  }

  // Sample rows for the most interesting tables
  async function sample(table, filter) {
    let q = supabase.from(table).select('*').limit(3)
    if (filter) q = q.eq(filter.col, filter.val)
    const { data, error } = await q
    return error ? { error: error.message } : data
  }
  report.samples = {
    live_conversation_messages: await sample('conversation_messages', { col: 'session_id', val: sessionId }),
    knowledge_items_demo: await sample('knowledge_items', { col: 'business_id', val: biz.id }),
    prod_conversations_demo: await sample('prod_conversations', { col: 'business_id', val: biz.id }),
    prod_messages_demo: await sample('prod_messages', { col: 'business_id', val: biz.id }),
    business_profiles_demo: await sample('business_profiles', { col: 'business_id', val: biz.id }),
    business_usage_daily_demo: await sample('business_usage_daily', { col: 'business_id', val: biz.id }),
  }

  report.finished_at = new Date().toISOString()
  writeFileSync('./tests/demo_audit.json', JSON.stringify(report, null, 2), 'utf8')
  console.log('\nReport written to tests/demo_audit.json')
  console.log('\n=== TABLE SUMMARY ===')
  for (const [t, cell] of Object.entries(report.tables)) {
    console.log(`${t.padEnd(30)}`, JSON.stringify(cell))
  }
}

run().catch(e => { console.error('FAILED:', e); process.exit(1) })
