// index.js boots the full server on import (app.listen at module scope), so
// — same convention as conversation-modules.test.js and context.test.js's
// "Cross-tenant write guards" section — its wiring is source-pinned by
// reading the file as text, not by importing and executing it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('logUsage is imported from lib/logger.js', () => {
  assert.match(src, /import \{[^}]*logUsage[^}]*\} from '\.\/lib\/logger\.js'/);
});

test('logUsage is called with the conversation agent\'s model_usage right after the result is unpacked', () => {
  const rIdx = src.indexOf('const r = agentResult.result;');
  const logIdx = src.indexOf('logUsage(run, r.model_usage)');
  assert.ok(rIdx > -1, '`const r = agentResult.result;` not found');
  assert.ok(logIdx > -1, 'logUsage(run, r.model_usage) call not found');
  assert.ok(logIdx > rIdx, 'logUsage must run after r is defined');
  // Must be gated so a turn with no model calls (e.g. setup/learning agents,
  // or a direct-KB hit) never calls it with an empty/undefined list.
  const guardWindow = src.slice(Math.max(0, logIdx - 200), logIdx);
  assert.match(guardWindow, /r\?\.model_usage\?\.length/);
});

test('a kb_direct hit gets its own step, separate from conversation_agent, carrying the matched question', () => {
  const outboundIdx = src.indexOf("const outbound_response = moduleStep.text;");
  const kbStepIdx = src.indexOf("stepStart(run, 'kb_direct'");
  assert.ok(outboundIdx > -1);
  assert.ok(kbStepIdx > -1, "stepStart(run, 'kb_direct', ...) not found");
  assert.ok(kbStepIdx > outboundIdx, 'the kb_direct step must be logged once outbound_response is known');
  const window = src.slice(kbStepIdx, kbStepIdx + 300);
  assert.match(window, /matched_question/);
  assert.match(window, /stepDone\(h,/);
});

// 2026-08-13, multi-question split: a kb_direct step must show EVERY matched
// row, not just the first — matched_question stays for existing consumers.
test('the kb_direct step also carries matched_questions — ALL matched rows, for a multi-question split', () => {
  const kbStepIdx = src.indexOf("stepStart(run, 'kb_direct'");
  const window = src.slice(kbStepIdx, kbStepIdx + 300);
  assert.match(window, /matched_questions:\s*r\.kb_direct\.questions/);
});

test('logUsage failures are swallowed — a logging problem must never fail the reply', () => {
  const logIdx = src.indexOf('logUsage(run, r.model_usage)');
  const window = src.slice(logIdx, logIdx + 150);
  assert.match(window, /\.catch\(/);
});
