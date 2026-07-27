// Snapshot / restore a business's bot configuration.
//
// Needed because a demo client is given edit access to a business we also pitch
// from: without a restore path, one afternoon of a prospect experimenting leaves
// the demo permanently altered.
//
//   node --env-file=.env.local scripts/snapshot-business.js save    <business_id> [label]
//   node --env-file=.env.local scripts/snapshot-business.js list    <business_id>
//   node --env-file=.env.local scripts/snapshot-business.js restore <business_id> <file>
//
// Only the CONFIG is captured — conversations, contacts and FAQ rows are left
// alone, so a restore never destroys real traffic history.
import { supabase } from '../lib/supabase.js';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(process.cwd(), 'snapshots');

const CONFIG_FIELDS = [
  'agent_mode', 'cta_goal', 'push_speed', 'persona', 'guardrails',
  'working_hours', 'agent_active', 'answer_after_hours', 'after_hours_message',
  'followup_enabled', 'followup_delay_days', 'followup_message',
  'sales_goal', 'conversation_strategy', 'decision_logic', 'objection_handling',
  'key_questions', 'business_model', 'business_category', 'faq_topics',
];

const [cmd, businessId, arg] = process.argv.slice(2);

if (!cmd || !businessId) {
  console.error('usage: snapshot-business.js save|list|restore <business_id> [label|file]');
  process.exit(1);
}

async function loadProfile() {
  const { data, error } = await supabase
    .from('business_profiles').select('*').eq('business_id', businessId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`no business_profiles row for ${businessId}`);
  return data;
}

if (cmd === 'save') {
  const profile = await loadProfile();
  const snapshot = {};
  for (const f of CONFIG_FIELDS) if (f in profile) snapshot[f] = profile[f];
  fs.mkdirSync(DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const label = arg ? `-${arg.replace(/[^a-zA-Z0-9_-]/g, '')}` : '';
  const file = path.join(DIR, `${businessId.slice(0, 8)}-${stamp}${label}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), 'utf8');
  console.log('saved:', file);
  console.log('fields captured:', Object.keys(snapshot).length);

} else if (cmd === 'list') {
  if (!fs.existsSync(DIR)) { console.log('no snapshots yet'); process.exit(0); }
  const files = fs.readdirSync(DIR).filter(f => f.startsWith(businessId.slice(0, 8)));
  if (!files.length) console.log('no snapshots for', businessId.slice(0, 8));
  for (const f of files.sort()) console.log(' ', path.join(DIR, f));

} else if (cmd === 'restore') {
  if (!arg) { console.error('restore needs a snapshot file'); process.exit(1); }
  const snapshot = JSON.parse(fs.readFileSync(arg, 'utf8'));
  const { error } = await supabase
    .from('business_profiles')
    .update({ ...snapshot, updated_at: new Date().toISOString() })
    .eq('business_id', businessId);
  if (error) { console.error('restore failed:', error.message); process.exit(1); }
  console.log('restored', Object.keys(snapshot).length, 'fields to', businessId);

} else {
  console.error('unknown command:', cmd);
  process.exit(1);
}
