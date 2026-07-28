import test from 'node:test';
import assert from 'node:assert/strict';
import { DELAY_WINDOWS, replyDelayMs } from '../lib/reply-delay.js';

const mid = () => 0.5;   // deterministic "random"
const lo = () => 0;
const hi = () => 0.999;

test('a short reply targets 4-9 seconds in total', () => {
  assert.deepEqual(DELAY_WINDOWS.short, [4000, 9000]);
});

test('the wait is the remainder of the target, not an addition to it', () => {
  // The old version slept 3-5s AFTER generation, so a 7-second model call felt
  // like 10-12 seconds. The target is now end-to-end.
  const ms = replyDelayMs({ words: 10, answerLength: 'short', elapsedMs: 3000, random: mid });
  assert.equal(ms, 6500 - 3000);
});

test('generation slower than the target means no extra wait at all', () => {
  assert.equal(replyDelayMs({ words: 10, answerLength: 'short', elapsedMs: 20000, random: mid }), 0);
});

test('an instant generation still waits the full target', () => {
  assert.equal(replyDelayMs({ words: 10, answerLength: 'short', elapsedMs: 0, random: lo }), 4000);
  assert.equal(replyDelayMs({ words: 10, answerLength: 'short', elapsedMs: 0, random: hi }), 8995);
});

test('a long reply gets a longer target than a short one', () => {
  const short = replyDelayMs({ words: 5, answerLength: 'short', elapsedMs: 0, random: mid });
  const long = replyDelayMs({ words: 60, answerLength: 'short', elapsedMs: 0, random: mid });
  assert.ok(long > short, 'a 60-word reply should not arrive as fast as a 5-word one');
});

test('word count promotes the band even when answer_length says short', () => {
  const a = replyDelayMs({ words: 25, answerLength: 'short', elapsedMs: 0, random: lo });
  assert.equal(a, DELAY_WINDOWS.medium[0]);
});

test('a missing elapsed time is treated as zero rather than NaN', () => {
  const ms = replyDelayMs({ words: 5, answerLength: 'short', random: lo });
  assert.equal(ms, 4000);
});

test('an unknown answer_length falls back to the short band', () => {
  const ms = replyDelayMs({ words: 5, answerLength: 'banana', elapsedMs: 0, random: lo });
  assert.equal(ms, DELAY_WINDOWS.short[0]);
});
