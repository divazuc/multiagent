import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('conversation.js extracts the action before validateAndFix', () => {
  const src = fs.readFileSync(new URL('../agents/conversation.js', import.meta.url), 'utf8');
  const extractIdx = src.indexOf('extractModuleAction(candidate)');
  const validateIdx = src.indexOf('validateAndFix({ candidate');
  assert.ok(extractIdx > -1 && validateIdx > -1 && extractIdx < validateIdx);
});

test('all three mode prompts include modules_context', () => {
  const src = fs.readFileSync(new URL('../agents/conversation.js', import.meta.url), 'utf8');
  assert.equal((src.match(/modules_context \? /g) || []).length, 3);
});

test('pipeline sends outbound_response (module confirmation included) to WhatsApp', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(src.includes('text: outbound_response'));
  assert.ok(src.includes("'meeting_booked'"));
});
