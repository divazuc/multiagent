import http from 'http';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const SESSION = 'demo-test-' + Date.now();

async function post(path, data) {
  return new Promise((resolve) => {
    const body = JSON.stringify(data);
    const req = http.request({
      host: 'localhost', port: 8080, path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.write(body); req.end();
  });
}

const delay = ms => new Promise(r => setTimeout(r, ms));

async function run() {
  console.log('Session:', SESSION);

  // 1. Create business
  const { data: biz, error: bizErr } = await sb
    .from('businesses')
    .insert({ name: 'Demo Cleaning Co', plan_type: 'basic', status: 'active', is_test: true })
    .select().single();
  if (bizErr) { console.error('Business failed:', bizErr.message); return; }
  console.log('✓ Business:', biz.id);

  // 2. Create session
  const { error: sessErr } = await sb.from('sessions').insert({
    session_id: SESSION, business_id: biz.id,
    session_mode: 'setup', current_stage: 'business_type', setup_completed: false,
  });
  if (sessErr) { console.error('Session failed:', sessErr.message); return; }

  // Create draft row
  await sb.from('setup_drafts').insert({
    session_id: SESSION, business_id: biz.id,
    current_setup_stage: 'business_type', draft_setup_data: {},
  });
  console.log('✓ Session + draft created');

  // 3. Setup stages
  const stages = [
    { stage: 'business_type',   value: 'service' },
    { stage: 'faq_topics',      value: ['pricing', 'availability', 'how_it_works', 'service_area'] },
    { stage: 'cta_goal',        value: 'book_call' },
    { stage: 'push_speed',      value: 'balanced' },
    { stage: 'tone',            value: ['warm', 'friendly'] },
    { stage: 'response_length', value: 'short' },
    { stage: 'emoji_usage',     value: 'light' },
    { stage: 'escalation',      value: ['high_value', 'user_asks'] },
    { stage: 'faq_examples',    value: 'Q: כמה עולה ניקיון?\nA: תלוי בגודל הדירה, החל מ-₪200.' },
    { stage: 'objections',      value: 'יקר מדי -> האיכות מדברת בעד עצמה, יש ניסיון חינם.' },
    { stage: 'forbidden_claims',value: 'אל תבטיח זמינות ביום אותו יום ללא בדיקה.' },
    { stage: 'final_note',      value: 'תמיד לסיים עם צעד הבא ספציפי.' },
  ];

  for (const s of stages) {
    await delay(400);
    const r = await post('/setup/save', { session_id: SESSION, ...s });
    const ok = r.status === 'success';
    console.log(ok ? '✓' : '✗', s.stage, '->', r.next_stage ?? r.message ?? 'no next stage');
    if (!ok) console.log('  ERROR:', JSON.stringify(r));
  }

  // 4. Commit
  await delay(400);
  const commit = await post('/setup/commit', { session_id: SESSION });
  console.log(commit.status === 'success' ? '✓ Committed' : '✗ Commit failed:', commit.message ?? '');

  // 5. Switch to live + test conversation
  await sb.from('sessions').update({ session_mode: 'live', setup_completed: true, current_stage: 'start' }).eq('session_id', SESSION);
  console.log('\n--- Conversation test (live mode) ---');

  const leads = [
    'שלום, אני מחפש שירות ניקיון לדירה של 4 חדרים בתל אביב',
    'כמה זה יעלה בערך?',
    'מתי אתם יכולים להגיע?',
  ];

  for (const msg of leads) {
    await delay(2000);
    const r = await post('/wa-inbound', { message: msg, session_id: SESSION });
    console.log(`\nLead: "${msg}"`);
    console.log(`Agent: "${(r.message ?? '').slice(0, 120)}"`);
    console.log(`Stage: ${r.state?.stage ?? '?'} | Status: ${r.status}`);
    if (r.status !== 'success') console.log('ERROR:', r.message);
  }

  // 6. Verify profile
  const { data: profile } = await sb.from('business_profiles')
    .select('agent_mode, cta_goal, faq_topics, persona, knowledge')
    .eq('session_id', SESSION).single();

  console.log('\n--- Saved Business Profile ---');
  console.log('agent_mode:', profile?.agent_mode);
  console.log('cta_goal:  ', profile?.cta_goal);
  console.log('faq_topics:', profile?.faq_topics);
  console.log('persona:   ', JSON.stringify(profile?.persona)?.slice(0, 120));
  console.log('knowledge: ', JSON.stringify(profile?.knowledge)?.slice(0, 120));

  // 7. Verify agent_runs logged
  const { data: runs } = await sb.from('agent_runs').select('status, session_mode, total_duration_ms').order('created_at', { ascending: false }).limit(3);
  console.log('\n--- Agent Runs ---');
  runs?.forEach(r => console.log(r.status, r.session_mode, r.total_duration_ms + 'ms'));

  console.log('\n✅ Demo test complete');
}

run().catch(e => console.error('FATAL:', e.message));
