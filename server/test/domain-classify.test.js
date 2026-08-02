import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBotTests, defaultBotId, classifyText } from '../lib/domain-classify.js';

const BOTS = [
  { id: 'doctors', name: 'הכשרות וקורסים', keywords: 'קורס|רופא|הכשר|סילבוס|השתלמ|בי.?ה.?ס' },
  { id: 'treatments', name: 'טיפולים אסתטיים', keywords: null },
  { id: 'hair', name: 'השתלות שיער', keywords: 'שיער|גבות|זקן|השתל|קרקפת|נשיר|FUE' },
];

test('buildBotTests keeps array order and skips the default (null-keywords) bot', () => {
  const tests = buildBotTests(BOTS);
  assert.deepEqual(tests.map(t => t.id), ['doctors', 'hair']);
  assert.ok(tests[0].re.test('רוצה פרטים על קורס הזרקות'));
});

test('buildBotTests returns null when there is no usable config', () => {
  assert.equal(buildBotTests(null), null);
  assert.equal(buildBotTests([]), null);
  assert.equal(buildBotTests([{ id: 'x', keywords: null }]), null); // no testable bot
});

test('buildBotTests survives an invalid regex by skipping that bot', () => {
  const tests = buildBotTests([
    { id: 'bad', keywords: '[' },
    { id: 'hair', keywords: 'שיער' },
    { id: 'treatments', keywords: null },
  ]);
  assert.deepEqual(tests.map(t => t.id), ['hair']);
});

test('defaultBotId picks the first null-keywords bot, else the first bot', () => {
  assert.equal(defaultBotId(BOTS), 'treatments');
  assert.equal(defaultBotId([{ id: 'a', keywords: 'x' }, { id: 'b', keywords: 'y' }]), 'a');
  assert.equal(defaultBotId([]), null);
  assert.equal(defaultBotId(null), null);
});

test('classifyText: first matching bot in array order wins; no match falls to default', () => {
  assert.equal(classifyText('אני רופאה ומתעניינת בקורס', BOTS), 'doctors');
  // "קורס הזרקות" must classify as doctors even though הזרק could look treatment-y
  assert.equal(classifyText('כמה עולה קורס הזרקות?', BOTS), 'doctors');
  assert.equal(classifyText('שאלה על השתלת שיער', BOTS), 'hair');
  assert.equal(classifyText('רוצה לקבוע בוטוקס', BOTS), 'treatments');
  assert.equal(classifyText('', BOTS), 'treatments');
  assert.equal(classifyText('כל טקסט', null), null);
});
