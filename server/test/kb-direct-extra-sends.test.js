// index.js boots the full server on import (app.listen at module scope), so —
// same convention as usage-wiring.test.js and conversation-modules.test.js —
// its wiring is source-pinned by reading the file as text, not by importing
// and executing it.
//
// Covers the pipeline side of the 2026-08-13 multi-question kb_direct split
// (agents/conversation.js#matchMultiDirectKb): a hit answers with a main
// `response` plus zero or more `extra_messages`, each of which must be sent
// as its own WhatsApp message, in order, through the exact same
// coexistence-guarded send path as the first message (so standdown
// cancellation and self-send-ring registration apply automatically), with a
// short randomized human-feeling gap between sends — and the saved
// conversation history must read as the whole turn, not just the first line.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('extra_messages is derived from the conversation agent result, defaulting to an empty array', () => {
  const idx = src.indexOf('const extra_messages = Array.isArray(r?.extra_messages)');
  assert.ok(idx > -1, 'extra_messages must be read off r?.extra_messages');
});

test('a short randomized gap (1.5-3s), not reply-delay\'s total-budget window, sits between extra sends', () => {
  assert.match(src, /EXTRA_MESSAGE_GAP_MS\s*=\s*\[1500,\s*3000\]/);
  assert.match(src, /function extraMessageGapMs\(/);
  // Must NOT reuse lib/reply-delay.js's replyDelayMs for this — that budget
  // is measured against generation time and only applies to the first
  // message.
  const gapFnIdx = src.indexOf('function extraMessageGapMs(');
  const gapFnBody = src.slice(gapFnIdx, gapFnIdx + 300);
  assert.doesNotMatch(gapFnBody, /replyDelayMs/);
});

test('the main response is sent first; extras are looped afterward, each waiting on the gap before sending', () => {
  const firstSendIdx = src.indexOf('sendWhatsAppMessage({ to: session_id, text: outbound_response, businessId: business_id })');
  const loopIdx = src.indexOf('for (const extra of extra_messages)');
  const gapCallIdx = src.indexOf('setTimeout(resolve, extraMessageGapMs())');
  const extraSendIdx = src.indexOf('sendWhatsAppMessage({ to: session_id, text: extra, businessId: business_id })');
  assert.ok(firstSendIdx > -1, 'the first send must still send outbound_response');
  assert.ok(loopIdx > firstSendIdx, 'the extras loop must come after the first send');
  assert.ok(gapCallIdx > loopIdx && gapCallIdx < extraSendIdx,
    'each extra must wait on the randomized gap BEFORE it sends');
});

test('every extra send goes through sendUnlessStoodDown, the same coexistence-guarded path as the first message', () => {
  const loopIdx = src.indexOf('for (const extra of extra_messages)');
  const loopBody = src.slice(loopIdx, loopIdx + 400);
  assert.match(loopBody, /sendUnlessStoodDown\(session_id, business_id, \(\)/,
    'extras must reuse the same send seam — standdown cancellation and self-send-ring registration (recordSentMessageId inside sendWhatsAppMessage) apply automatically, with no separate wiring for extras');
  assert.match(loopBody, /sendWhatsAppMessage\(/);
});

test('a standdown cancellation on the first message also stops the extras from going out', () => {
  const firstAwaitIdx = src.indexOf('const first = await sendUnlessStoodDown(session_id, business_id, ()');
  const loopIdx = src.indexOf('for (const extra of extra_messages)');
  assert.ok(firstAwaitIdx > -1);
  const between = src.slice(firstAwaitIdx, loopIdx);
  assert.match(between, /if \(first\.cancelled\) return;/);
});

test('a standdown cancellation mid-burst stops the remaining extras', () => {
  const loopIdx = src.indexOf('for (const extra of extra_messages)');
  const loopBody = src.slice(loopIdx, loopIdx + 400);
  assert.match(loopBody, /if \(sent\.cancelled\) break;/);
});

test('the saved conversation history joins the main response with every extra message ("\\n\\n"), keeping saveConversation\'s shape unchanged', () => {
  const joinIdx = src.indexOf('[outbound_response, ...extra_messages].join(');
  assert.ok(joinIdx > -1, 'the saved agent_response must be built from outbound_response + extra_messages');
  const window = src.slice(joinIdx, joinIdx + 60);
  assert.match(window, /join\('\\n\\n'\)/);

  const saveIdx = src.indexOf('saveConversation({');
  const saveWindow = src.slice(saveIdx, saveIdx + 200);
  assert.match(saveWindow, /agent_response: agent_response_for_history/,
    'saveConversation must receive the joined text, not the bare outbound_response, so multi-message turns are fully banked in history');
});
