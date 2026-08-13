// Conversation simulation harness (owner request 2026-08-13): run scripted
// parent scenarios DIRECTLY against the conversation agent — no WhatsApp, no
// real sessions, no leads rows, nothing written to the DB. Context is built
// in-memory from the live business profile + KB (read-only queries), history
// accumulates locally, and business_id is deliberately null so the escalation
// path returns its phrase without raising a real relay/Telegram event.
//
//   railway run node scripts/simulate-kids-conversations.mjs [--out file.md]
//
// Output: a Markdown transcript (default: sim-transcript.md next to this
// script, gitignored via scripts/backups) with per-message cost and flags.
import { supabase } from '../lib/supabase.js';
import { runConversation } from '../agents/conversation.js';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BIZ = 'f53bdccc-e62d-45f8-8c08-eee5594ce221';
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : fileURLToPath(new URL('./backups/sim-transcript.md', import.meta.url));

const SCENARIOS = [
  { name: 'גיל ושעות (הבאג של הבוקר)', turns: [
    'היי',
    'רועי בן 7, מתי מתקיים החוג?',
    'ומה המחיר?',
  ]},
  { name: 'היגיון מחיר שנתי', turns: [
    'למה משלמים אותו סכום גם בחודש עם חגים?',
    'מה ההיגיון לשלם את אותו סכום על פעם אחת במקום פעמיים?',
  ]},
  { name: 'הרשמה לניסיון — טופס קודם', turns: [
    'איך נרשמים לאימון ניסיון? מתי יש אימון?',
  ]},
  { name: 'פעם בשבוע', turns: [
    'אפשר להביא את הילדה רק פעם בשבוע? ראשון לא נוח לנו',
  ]},
  { name: 'מבוגרים — שאלה מפורשת (מותר סאלי)', turns: [
    'יש אצלכם גם אימונים למבוגרים?',
  ]},
  { name: 'ביטול — מדיניות מול בקשה', turns: [
    'מה מדיניות הביטול אצלכם?',
    'אני רוצה לבטל את ההרשמה של הבן שלי',
  ]},
  { name: 'האם את בוטית', turns: [
    'רגע, אני מדברת עם בוט?',
  ]},
  { name: 'התאמה לילד ביישן', turns: [
    'הבת שלי בת 8 וממש ביישנית, לא בטוחה שזה מתאים לה',
  ]},
];

// in-memory context, mirroring lib/context.js's shape for live mode
const { data: prof, error } = await supabase.from('business_profiles')
  .select('*').eq('business_id', BIZ).maybeSingle();
if (error || !prof) { console.error('profile load failed:', error?.message); process.exit(1); }
const { data: kbRows } = await supabase.from('knowledge_items')
  .select('question, answer, category, archetypes').eq('business_id', BIZ).eq('is_active', true);

const parse = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };
const persona = parse(prof.persona, {});
const baseContext = {
  business_id: null, // sim: escalations return their phrase, no real relay
  session_mode: 'live',
  agent_mode: prof.agent_mode ?? 'hybrid',
  business_profile: {
    business_name: prof.business_name,
    ...parse(prof.profile_data, {}),
    knowledge: { ...parse(prof.knowledge, {}), items: kbRows ?? [] },
    answer_length: persona.answer_length,
  },
  persona,
  guardrails: parse(prof.guardrails, {}),
  hebrew_patterns: parse(prof.hebrew_patterns, {}),
  cta_goal: prof.cta_goal ?? 'הרשמה לאימון ניסיון דרך הטופס',
  qualification_progress: {},
  modules_context: null,
};

const lines = [`# סימולציית שיחות — נועה / קרוספיט קידס`, `_${new Date().toISOString()}_`, ''];
let totalCost = 0, totalMsgs = 0, directHits = 0;

for (const sc of SCENARIOS) {
  lines.push(`## ${sc.name}`);
  const history = [];
  for (const msg of sc.turns) {
    const res = await runConversation({
      message: msg,
      context: { ...baseContext, conversation_history: history },
      session_id: 'SIM-LOCAL',
    });
    const r = res?.result ?? {};
    const cost = r.model_usage_total?.cost_usd ?? 0;
    const direct = !!r.kb_direct?.matched;
    totalCost += cost; totalMsgs++; if (direct) directHits++;
    lines.push(`**הורה:** ${msg}`);
    lines.push(`**נועה:** ${r.response || '(ללא תשובה — ' + (res?.error ?? r.escalation_reason ?? '?') + ')'}`);
    lines.push(`<sub>${direct ? '⚡ תשובה ישירה מהמאגר — ₪0' : `עלות: $${cost.toFixed(4)}`}${r.escalate ? ' · 🔺 הוסלם' : ''}</sub>`);
    lines.push('');
    history.push({ role: 'user', content: msg });
    if (r.response) history.push({ role: 'assistant', content: r.response });
  }
  lines.push('---');
}
lines.push(`**סיכום:** ${totalMsgs} הודעות · $${totalCost.toFixed(4)} · ${directHits} תשובות ישירות בחינם`);
writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`wrote ${OUT}`);
console.log(`msgs: ${totalMsgs}, cost: $${totalCost.toFixed(4)}, direct: ${directHits}`);
