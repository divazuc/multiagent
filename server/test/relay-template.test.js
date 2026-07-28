// server/test/relay-template.test.js
//
// Task 10 — the rep hop goes out as an approved WhatsApp template.
//
// Messages TO A CONTACT are business-initiated and usually land outside
// WhatsApp's 24h customer-service window, so they must be templates. Messages
// to the LEAD stay plain text (the lead has just messaged us), and so do the
// acks the relay sends back inside a rep's own reply thread.
//
// The single rule these tests exist to protect: a MISSING template is a hard
// stop. Nothing is sent, no message id comes back, and therefore no state moves
// — never the `index.js` follow-up pattern of writing status 'sent' while
// `wa_send` says 'not_configured' and nothing left the building.
import test from 'node:test';
import assert from 'node:assert/strict';

// Every supabase/wa-send import in the relay is lazy (inside the call), so
// these assignments land before anything reads them even though ESM hoists
// the imports below. wa-send.js imports supabase.js at module top level and
// createClient() throws on an undefined URL — without these, the template
// path would blow up for the wrong reason and hide the behaviour under test.
process.env.SUPABASE_URL = 'http://supabase.invalid';
process.env.SUPABASE_SERVICE_KEY = 'stub-service-key';
process.env.WHATSAPP_PHONE_NUMBER_ID = 'PNID';
process.env.WHATSAPP_ACCESS_TOKEN = 'TOKEN';

import * as contacts from '../lib/relay/contacts.js';
import * as store from '../lib/relay/store.js';
import * as relay from '../lib/relay/index.js';

const BIZ = { id: 'b1', name: 'קליניקה' };
const REP = '972500000001';
const HOUR = 3600 * 1000;

// ── Network stub ─────────────────────────────────────────────────────────────
// The assertions below say "sends nothing" literally: zero HTTP requests to
// Graph. Anything else (a plain-text fallback slipping through, an unexpected
// second send) shows up here as a recorded call.
let fetchCalls = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  fetchCalls.push({ url: u, init });
  if (u.includes('graph.facebook.com')) return graphResponse();
  // The businesses lookup inside wa-send: failing it is harmless and exercises
  // the env-credential fallback, which is what a stubbed run should use.
  return new Response(JSON.stringify({ message: 'stubbed supabase' }),
    { status: 500, headers: { 'content-type': 'application/json' } });
};

let graphResponse = () => new Response(
  JSON.stringify({ messages: [{ id: 'wamid.TEMPLATE' }] }),
  { status: 200, headers: { 'content-type': 'application/json' } });

const graphCalls = () => fetchCalls.filter(c => c.url.includes('graph.facebook.com'));
const graphBodies = () => graphCalls().map(c => JSON.parse(c.init.body));

// ── console.error capture ────────────────────────────────────────────────────
// A hard stop must be loud. Asserting on the refusal line is what separates
// "refused on purpose" from "failed somewhere else and returned null anyway".
function captureErrors() {
  const lines = [];
  const real = console.error;
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  return { lines, restore() { console.error = real; } };
}

function seed({ rep = { business_id: 'b1', role: 'rep', name: 'סאלי', phone: REP } } = {}) {
  fetchCalls = [];
  contacts._setDbForTest({
    async listContacts() { return rep ? [rep] : []; },
    async upsertContact() {},
  });
  const rows = [];
  store._setDbForTest({
    async insert(row) { const r = { id: `e${rows.length + 1}`, ...row }; rows.push(r); return r; },
    async listOpen() { return [...rows].reverse(); },
    async listAllOpen() { return rows; },
    async update(id, patch) { Object.assign(rows.find(r => r.id === id), patch); },
  });
  relay._setDbForTest({
    async getBusiness() { return { whatsapp_number: null }; },
    async getSession() { return { qualification_progress: null }; },
  });
  relay._setHistorySaverForTest(async () => ({ status: 'success', result: {}, error: null }));
  return rows;
}

function seedOpen(rows) {
  fetchCalls = [];
  const state = [...rows];
  store._setDbForTest({
    async insert(r) { state.push(r); return r; },
    async listOpen(b) { return state.filter(r => r.business_id === b && r.status === 'open'); },
    async listAllOpen() { return state.filter(r => r.status === 'open'); },
    async update(id, patch) { Object.assign(state.find(r => r.id === id), patch); },
  });
  return state;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The unset-template path — the REAL path until the templates are approved
// ─────────────────────────────────────────────────────────────────────────────

test('an unset escalation template sends nothing, returns no message id, and leaves no escalation row', async () => {
  const rows = seed();
  relay._setSenderForTest(null);        // no test seam — exercise the real send path
  delete process.env.WHATSAPP_ESCALATION_TEMPLATE;

  const errs = captureErrors();
  const r = await relay.raiseEscalation({
    business: BIZ, session_id: 's_tmpl_1', question: 'אפשר לפרוס לתשלומים?',
    summary: 'מתעניינת בטיפול פנים', leadName: 'דנה', persona: { bot_gender: 'female' },
  });
  errs.restore();

  assert.equal(graphCalls().length, 0, 'a missing template must send nothing at all — not even plain text');
  assert.equal(r, null, 'no holding line: nobody was asked, so the lead must not be told we are checking');
  assert.equal(rows.length, 0, 'no escalation row may exist for a question that was never delivered');
  assert.ok(errs.lines.some(l => l.includes('WHATSAPP_ESCALATION_TEMPLATE')),
    'the refusal must be logged by name, not swallowed — this is a config error an operator has to see');
});

test('an unset nudge template sends nothing and does not consume the nudge budget', async () => {
  const now = new Date('2026-07-26T09:00:00Z');
  const rows = seedOpen([{ id: 'e1', business_id: 'b1', status: 'open', short_code: 1,
    rep_phone: REP, session_id: 's_tmpl_2', question: 'שאלה', nudge_count: 0,
    last_nudge_at: new Date(now - 3 * HOUR).toISOString() }]);
  relay._setSenderForTest(null);
  delete process.env.WHATSAPP_NUDGE_TEMPLATE;

  const errs = captureErrors();
  const r = await relay.nudgePass({ now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4 });
  errs.restore();

  assert.equal(graphCalls().length, 0, 'a missing template must send nothing at all');
  assert.equal(r.nudged, 0, 'a nudge that was never sent must not be counted as nudged');
  assert.equal(rows[0].nudge_count, 0, 'the budget must not be burned on a nudge nobody received');
  assert.equal(rows[0].last_nudge_at, new Date(now - 3 * HOUR).toISOString(),
    'last_nudge_at must not move — otherwise the next pass waits another interval for nothing');
  assert.equal(rows[0].status, 'open');
  assert.ok(errs.lines.some(l => l.includes('WHATSAPP_NUDGE_TEMPLATE')), 'the refusal must be logged by name');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The injected-sender seam must keep working, untouched by templates
// ─────────────────────────────────────────────────────────────────────────────

test('an injected sender bypasses the template path entirely, even with the template env set', async () => {
  const rows = seed();
  process.env.WHATSAPP_ESCALATION_TEMPLATE = 'escalation_notify';
  const sent = [];
  relay._setSenderForTest(async (msg) => { sent.push(msg); return { messages: [{ id: 'wamid.FAKE' }] }; });

  const r = await relay.raiseEscalation({
    business: BIZ, session_id: 's_tmpl_3', question: 'אפשר לפרוס לתשלומים?',
    summary: 'מתעניינת בטיפול פנים', leadName: 'דנה', persona: { bot_gender: 'female' },
  });

  assert.equal(graphCalls().length, 0, 'the seam must short-circuit before any template lookup or Graph call');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, REP);
  assert.equal(sent[0].businessId, 'b1');
  assert.match(sent[0].text, /#1/, 'the fake sender still receives the readable plain-text message');
  assert.match(sent[0].text, /אפשר לפרוס לתשלומים\?/);
  assert.ok(r.holdingLine.length > 0);
  assert.equal(rows[0].rep_message_id, 'wamid.FAKE');
  assert.equal(rows[0].status, 'open');

  delete process.env.WHATSAPP_ESCALATION_TEMPLATE;
});

test('an injected sender bypasses the template path for nudges too', async () => {
  const now = new Date('2026-07-26T09:00:00Z');
  const rows = seedOpen([{ id: 'e1', business_id: 'b1', status: 'open', short_code: 7,
    rep_phone: REP, session_id: 's_tmpl_4', question: 'שאלה על מחיר', nudge_count: 0,
    last_nudge_at: new Date(now - 3 * HOUR).toISOString() }]);
  process.env.WHATSAPP_NUDGE_TEMPLATE = 'escalation_nudge';
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.FAKE' }] }; });

  const r = await relay.nudgePass({ now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4 });

  assert.equal(graphCalls().length, 0, 'the seam must short-circuit before any template lookup or Graph call');
  assert.equal(r.nudged, 1);
  assert.equal(sent[0].to, REP);
  assert.match(sent[0].text, /#7/);
  assert.equal(rows[0].nudge_count, 1);

  delete process.env.WHATSAPP_NUDGE_TEMPLATE;
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The configured path — what actually goes to Graph
// ─────────────────────────────────────────────────────────────────────────────

test('a configured escalation template posts a Hebrew template with code, name, summary and question in order', async () => {
  const rows = seed();
  relay._setSenderForTest(null);
  process.env.WHATSAPP_ESCALATION_TEMPLATE = 'escalation_notify';

  const r = await relay.raiseEscalation({
    business: BIZ, session_id: 's_tmpl_5', question: 'אפשר לפרוס לתשלומים?',
    summary: 'מתעניינת בטיפול פנים', leadName: 'דנה', persona: { bot_gender: 'female' },
  });

  assert.equal(graphCalls().length, 1);
  const body = graphBodies()[0];
  assert.equal(body.type, 'template');
  assert.equal(body.to, REP);
  assert.equal(body.template.name, 'escalation_notify');
  assert.equal(body.template.language.code, 'he');
  assert.deepEqual(body.template.components[0].parameters.map(p => p.text),
    ['1', 'דנה', 'מתעניינת בטיפול פנים', 'אפשר לפרוס לתשלומים?']);
  assert.ok(r.holdingLine.length > 0);
  assert.equal(rows[0].rep_message_id, 'wamid.TEMPLATE');

  delete process.env.WHATSAPP_ESCALATION_TEMPLATE;
});

// Graph rejects template parameters containing newlines, tabs, or runs of 4+
// spaces — and a lead's WhatsApp question routinely contains a newline. An
// unsanitised parameter fails the whole send, which (correctly, but silently
// to the client) means the rep is never asked. Collapse the whitespace instead.
test('template parameters are whitespace-collapsed and empty ones become a placeholder', async () => {
  seed();
  relay._setSenderForTest(null);
  process.env.WHATSAPP_ESCALATION_TEMPLATE = 'escalation_notify';

  await relay.raiseEscalation({
    business: BIZ, session_id: 's_tmpl_6',
    question: 'שלום,\nאפשר לפרוס    לתשלומים?\tתודה',
    summary: null, leadName: null, persona: {},
  });

  const params = graphBodies()[0].template.components[0].parameters.map(p => p.text);
  assert.ok(!/[\n\t]/.test(params[3]), 'newlines and tabs must never reach Graph');
  assert.ok(!/ {4}/.test(params[3]), 'runs of four or more spaces must never reach Graph');
  assert.equal(params[3], 'שלום, אפשר לפרוס לתשלומים? תודה');
  assert.ok(params[1].length > 0, 'a missing lead name must become a placeholder, not an empty parameter');
  assert.ok(params[2].length > 0, 'a missing summary must become a placeholder, not an empty parameter');

  delete process.env.WHATSAPP_ESCALATION_TEMPLATE;
});

test('a configured nudge template posts the short code and question, and records the nudge', async () => {
  const now = new Date('2026-07-26T09:00:00Z');
  const rows = seedOpen([{ id: 'e1', business_id: 'b1', status: 'open', short_code: 3,
    rep_phone: REP, session_id: 's_tmpl_7', question: 'שאלה על מחיר', nudge_count: 1,
    last_nudge_at: new Date(now - 3 * HOUR).toISOString() }]);
  relay._setSenderForTest(null);
  process.env.WHATSAPP_NUDGE_TEMPLATE = 'escalation_nudge';

  const r = await relay.nudgePass({ now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4 });

  assert.equal(graphCalls().length, 1);
  const body = graphBodies()[0];
  assert.equal(body.template.name, 'escalation_nudge');
  assert.equal(body.template.language.code, 'he');
  assert.deepEqual(body.template.components[0].parameters.map(p => p.text), ['3', 'שאלה על מחיר']);
  assert.equal(r.nudged, 1);
  assert.equal(rows[0].nudge_count, 2);

  delete process.env.WHATSAPP_NUDGE_TEMPLATE;
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. A rejected template is the same hard stop as a missing one
// ─────────────────────────────────────────────────────────────────────────────

test('a template Graph rejects (e.g. not approved yet) leaves no escalation row', async () => {
  const rows = seed();
  relay._setSenderForTest(null);
  process.env.WHATSAPP_ESCALATION_TEMPLATE = 'escalation_notify';
  graphResponse = () => new Response(
    JSON.stringify({ error: { code: 132001, message: 'Template name does not exist' } }),
    { status: 400, headers: { 'content-type': 'application/json' } });

  const r = await relay.raiseEscalation({
    business: BIZ, session_id: 's_tmpl_8', question: 'שאלה', persona: {},
  });

  assert.equal(r, null, 'a rejected template must not promise the lead an answer');
  assert.equal(rows.length, 0);

  graphResponse = () => new Response(JSON.stringify({ messages: [{ id: 'wamid.TEMPLATE' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  delete process.env.WHATSAPP_ESCALATION_TEMPLATE;
});

// An ATTEMPTED send is charged even when Graph rejects it. It has to be:
// store.markExpired has exactly one caller and it is gated solely on
// nudge_count, so a rep who is permanently unreachable (number not on
// WhatsApp, business blocked, template paused by Meta) would otherwise leave
// the row open forever — and one immortal open row silently re-routes the
// next untagged rep reply to a dead lead (correlate.js single-match) and
// leaks its short code out of the 1..99 space (store.js#nextShortCode).
// This is the opposite of the LOCAL-refusal case above, which charges nobody.
test('a nudge Graph rejected still counts toward the ceiling so the row can eventually expire', async () => {
  const now = new Date('2026-07-26T09:00:00Z');
  const rows = seedOpen([{ id: 'e1', business_id: 'b1', status: 'open', short_code: 1,
    rep_phone: REP, session_id: 's_tmpl_9', question: 'שאלה', nudge_count: 0,
    created_at: new Date(now - 3 * HOUR).toISOString(),
    last_nudge_at: new Date(now - 3 * HOUR).toISOString() }]);
  relay._setSenderForTest(null);
  process.env.WHATSAPP_NUDGE_TEMPLATE = 'escalation_nudge';
  graphResponse = () => new Response(
    JSON.stringify({ error: { code: 132001, message: 'Template name does not exist' } }),
    { status: 400, headers: { 'content-type': 'application/json' } });

  const r = await relay.nudgePass({ now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4 });

  assert.equal(graphCalls().length, 1, 'the send was attempted — that is what makes it chargeable');
  assert.equal(r.nudged, 0, 'nothing was delivered, so nothing is reported as nudged');
  assert.equal(rows[0].nudge_count, 1, 'an attempted-and-rejected nudge must still count against the ceiling');
  assert.ok(rows[0].last_nudge_at, 'last_nudge_at must move, or the row is eligible again on every pass forever');

  graphResponse = () => new Response(JSON.stringify({ messages: [{ id: 'wamid.TEMPLATE' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  delete process.env.WHATSAPP_NUDGE_TEMPLATE;
});

test('a permanently rejecting rep number walks the escalation to the ceiling and expires it', async () => {
  // Anchored at the real clock, not a fixed past date: store.recordNudge
  // stamps last_nudge_at with wall-clock time, so a simulated timeline that
  // sits in the past would have every pass after the first see a
  // last_nudge_at in its own future and skip on the interval gate.
  const start = new Date();
  const rows = seedOpen([{ id: 'e1', business_id: 'b1', status: 'open', short_code: 1,
    rep_phone: REP, session_id: 's_tmpl_10', question: 'שאלה', nudge_count: 0,
    created_at: start.toISOString(), last_nudge_at: start.toISOString() }]);
  relay._setSenderForTest(null);
  process.env.WHATSAPP_NUDGE_TEMPLATE = 'escalation_nudge';
  graphResponse = () => new Response(
    JSON.stringify({ error: { code: 131026, message: 'Receiver is not a WhatsApp user' } }),
    { status: 400, headers: { 'content-type': 'application/json' } });

  // Five passes, three hours apart — well inside the 72h age cap, so this
  // proves the COUNTER path terminates on its own rather than the backstop.
  let expired = 0;
  for (let i = 1; i <= 5; i++) {
    const r = await relay.nudgePass({
      now: new Date(start.getTime() + i * 3 * HOUR),
      isOpenNow: async () => true, intervalHours: 2, maxNudges: 4,
    });
    expired += r.expired;
  }

  assert.equal(rows[0].status, 'expired', 'an undeliverable rep must not leave the escalation open forever');
  assert.equal(expired, 1);

  graphResponse = () => new Response(JSON.stringify({ messages: [{ id: 'wamid.TEMPLATE' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  delete process.env.WHATSAPP_NUDGE_TEMPLATE;
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The absolute age backstop — the exit that survives a stopped counter
// ─────────────────────────────────────────────────────────────────────────────

test('an open escalation past the absolute age cap is expired even when nothing can be sent at all', async () => {
  const now = new Date('2026-07-26T09:00:00Z');
  const rows = seedOpen([{ id: 'e1', business_id: 'b1', status: 'open', short_code: 1,
    rep_phone: REP, session_id: 's_tmpl_11', question: 'שאלה', nudge_count: 0,
    created_at: new Date(now - 96 * HOUR).toISOString(),
    last_nudge_at: new Date(now - 96 * HOUR).toISOString() }]);
  relay._setSenderForTest(null);
  delete process.env.WHATSAPP_NUDGE_TEMPLATE;   // e.g. the env lost in a redeploy

  const r = await relay.nudgePass({ now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4 });

  assert.equal(graphCalls().length, 0, 'still nothing sent — the backstop is a state transition, not a send');
  assert.equal(r.expired, 1);
  assert.equal(rows[0].status, 'expired',
    'a row whose counter can never advance must still stop being open — it would otherwise mis-route rep replies and leak its short code');
});

test('the age cap never preempts a business configured for a longer nudge ladder', async () => {
  const now = new Date('2026-07-26T09:00:00Z');
  // 24h × 4 legitimately needs ~96h. A flat 72h cap would kill this mid-ladder.
  const rows = seedOpen([{ id: 'e1', business_id: 'b1', status: 'open', short_code: 1,
    rep_phone: REP, session_id: 's_tmpl_12', question: 'שאלה', nudge_count: 1,
    created_at: new Date(now - 80 * HOUR).toISOString(),
    last_nudge_at: new Date(now - 30 * HOUR).toISOString() }]);
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.FAKE' }] }; });

  const r = await relay.nudgePass({
    now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4,
    getNudgeSettings: async () => ({ nudge_interval_hours: 24, nudge_max_count: 4 }),
  });

  assert.equal(r.expired, 0, 'an 80h-old row is still inside a 24h × 4 ladder');
  assert.equal(rows[0].status, 'open');
  assert.equal(r.nudged, 1, 'and it must still be nudged normally');
});

test('a missing nudge template is logged once per pass, not once per open escalation', async () => {
  const now = new Date('2026-07-26T09:00:00Z');
  seedOpen([1, 2, 3].map(n => ({ id: `e${n}`, business_id: 'b1', status: 'open', short_code: n,
    rep_phone: REP, session_id: `s_tmpl_13_${n}`, question: 'שאלה', nudge_count: 0,
    last_nudge_at: new Date(now - 3 * HOUR).toISOString() })));
  relay._setSenderForTest(null);
  delete process.env.WHATSAPP_NUDGE_TEMPLATE;

  const errs = captureErrors();
  const r = await relay.nudgePass({ now, isOpenNow: async () => true, intervalHours: 2, maxNudges: 4 });
  errs.restore();

  assert.equal(r.nudged, 0);
  assert.equal(errs.lines.filter(l => l.includes('WHATSAPP_NUDGE_TEMPLATE')).length, 1,
    'a refusal that applies identically to every row is decided once, not shouted once per row');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Parameter length
// ─────────────────────────────────────────────────────────────────────────────

// Graph rejects a body parameter over 1024 characters and inbound WhatsApp
// text runs to 4096, so an unguarded {{4}} fails the whole send — meaning no
// escalation row, meaning the lead silently loses the relay.
test('an over-long question is truncated on a word boundary instead of failing the send', async () => {
  seed();
  relay._setSenderForTest(null);
  process.env.WHATSAPP_ESCALATION_TEMPLATE = 'escalation_notify';

  const long = Array.from({ length: 400 }, (_, i) => `מילה${i}`).join(' '); // ≫ 1024 chars
  await relay.raiseEscalation({
    business: BIZ, session_id: 's_tmpl_14', question: long, persona: {},
  });

  assert.equal(graphCalls().length, 1, 'the send must still happen, not be abandoned');
  const param = graphBodies()[0].template.components[0].parameters[3].text;
  assert.ok(param.length <= 500, `parameter must stay under the cap, got ${param.length}`);
  assert.ok(param.endsWith('…'), 'truncation must be visible to the rep');
  assert.ok(long.startsWith(param.slice(0, -1)), 'the kept prefix must be verbatim');
  assert.ok(!/מילה\d*$/.test(param.slice(0, -1)) || long.includes(param.slice(0, -1) + ' '),
    'the cut must land on a word boundary, not mid-word');

  delete process.env.WHATSAPP_ESCALATION_TEMPLATE;
});

test('a single unspaced blob is still truncated rather than collapsing to nothing', async () => {
  seed();
  relay._setSenderForTest(null);
  process.env.WHATSAPP_ESCALATION_TEMPLATE = 'escalation_notify';

  await relay.raiseEscalation({
    business: BIZ, session_id: 's_tmpl_15', question: 'א'.repeat(2000), persona: {},
  });

  const param = graphBodies()[0].template.components[0].parameters[3].text;
  assert.ok(param.length > 400 && param.length <= 500,
    `one 2000-char "word" must not truncate back to nothing, got ${param.length}`);

  delete process.env.WHATSAPP_ESCALATION_TEMPLATE;
});
