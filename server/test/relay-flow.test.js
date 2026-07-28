// server/test/relay-flow.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import * as contacts from '../lib/relay/contacts.js';
import * as store from '../lib/relay/store.js';
import * as relay from '../lib/relay/index.js';

const BIZ = { id: 'b1', name: 'קליניקה' };

// businessWhatsapp: the business's OWN WhatsApp number as it would come back
// from the `businesses` table. Defaults to null (unknown/not set) so the
// three original flow tests below are unaffected by the own-number guard.
// sessionQualificationProgress: what the `sessions` row for the lead already
// holds — the relay's history write must pass this through unchanged.
function seed({
  rep = { business_id: 'b1', role: 'rep', name: 'סאלי', phone: '972500000001' },
  businessWhatsapp = null,
  sessionQualificationProgress = null,
  // Simulates the partial unique index `escalations_open_code_uniq` rejecting
  // the insert — the check-then-act race in nextShortCode losing to another
  // request that already took the code.
  insertFails = false,
  // The lead's row in `contacts` — the name shown to the rep and the
  // ai_summary snapshot the design spec §2 requires. `undefined` means the
  // lookup itself throws.
  leadContact = null,
} = {}) {
  contacts._setDbForTest({
    async listContacts() { return rep ? [rep] : []; },
    async upsertContact() {},
  });
  const rows = [];
  store._setDbForTest({
    async insert(row) {
      if (insertFails) throw new Error('duplicate key value violates unique constraint "escalations_open_code_uniq"');
      const r = { id: `e${rows.length + 1}`, ...row }; rows.push(r); return r;
    },
    async listOpen() { return [...rows].reverse().filter(r => r.status === 'open'); },
    async listAllOpen() { return rows.filter(r => r.status === 'open'); },
    async update(id, patch) { Object.assign(rows.find(r => r.id === id), patch); },
  });
  relay._setDbForTest({
    async getBusiness() { return { whatsapp_number: businessWhatsapp }; },
    async getSession() { return { qualification_progress: sessionQualificationProgress }; },
    async getLeadContact() {
      if (leadContact === undefined) throw new Error('transient db error');
      return leadContact;
    },
  });
  relay._setHistorySaverForTest(async () => ({ status: 'success', result: { saved: true }, error: null }));
  return rows;
}

test('raising an escalation messages the rep and returns a holding line', async () => {
  const rows = seed();
  const sent = [];
  relay._setSenderForTest(async (msg) => { sent.push(msg); return { messages: [{ id: 'wamid.X' }] }; });

  const r = await relay.raiseEscalation({
    business: BIZ, session_id: '97250000009',
    question: 'אפשר לפרוס לתשלומים?', reason: 'pricing', summary: 'מתעניינת בטיפול פנים',
    persona: { bot_gender: 'female' },
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, '972500000001');
  assert.match(sent[0].text, /#1/);
  assert.match(sent[0].text, /אפשר לפרוס לתשלומים\?/);
  assert.ok(r.holdingLine.length > 0);
  assert.equal(rows[0].rep_message_id, 'wamid.X');
  assert.equal(rows[0].status, 'open');
});

test('no reachable contact means no escalation row and no holding line', async () => {
  const rows = seed({ rep: null });
  relay._setSenderForTest(async () => { throw new Error('must not send'); });
  const r = await relay.raiseEscalation({
    business: BIZ, session_id: '97250000009', question: 'שאלה', persona: {},
  });
  assert.equal(r, null);
  assert.equal(rows.length, 0);
});

test('a failed send leaves no escalation behind', async () => {
  const rows = seed();
  relay._setSenderForTest(async () => null); // send failed — no message id
  const r = await relay.raiseEscalation({
    business: BIZ, session_id: '97250000009', question: 'שאלה', persona: {},
  });
  assert.equal(r, null, 'must not promise the lead an answer nobody was asked for');
  assert.equal(rows.filter(x => x.status === 'open').length, 0);
});

// ── C2: reserve the code BEFORE telling the rep anything ────────────────────
// The partial unique index escalations_open_code_uniq exists precisely to make
// the insert fail when nextShortCode's check-then-act loses a race. With
// send-before-insert the rep is left holding a real "#3 · <lead A's question>"
// with no row behind it; correlate.js then falls past contextId to the CODE,
// which matches the OTHER open row that legitimately holds #3 — and lead B
// receives the answer to lead A's question. In a clinic that answer is a price.

test('a lost short-code race sends the rep nothing at all', async () => {
  const rows = seed({ insertFails: true });
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.X' }] }; });

  const r = await relay.raiseEscalation({
    business: BIZ, session_id: '97250000009', question: 'אפשר לפרוס לתשלומים?', persona: {},
  });

  assert.equal(r, null, 'no holding line — nobody was successfully asked');
  assert.equal(sent.length, 0,
    'the rep must never hold a coded message with no row behind it: the code would resolve to another lead');
  assert.equal(rows.length, 0);
});

test('a send that fails after the row is reserved leaves no open row behind', async () => {
  const rows = seed();
  relay._setSenderForTest(async () => null); // Graph rejected it — no message id

  const r = await relay.raiseEscalation({
    business: BIZ, session_id: '97250000009', question: 'שאלה', persona: {},
  });

  assert.equal(r, null);
  assert.equal(rows.filter(x => x.status === 'open').length, 0,
    'a reserved-but-unsent row must not stay open: it would hold a short code and answer a rep\'s next reply');
  assert.equal(rows.length, 1, 'the row is kept, marked expired, so the reservation is auditable');
  assert.equal(rows[0].status, 'expired');
});

// ── I2: one persistent lead must not buy 99 rep templates ────────────────────
// Without a per-session dedupe every escalate-intent message creates another
// escalation, another billable business-initiated template, and another open
// row — up to the 99-code ceiling, each then drawing nudge_max_count more
// templates. The holding line actively invites the lead to keep pushing.

test('a second escalation for the same lead reuses the open one and sends nothing', async () => {
  const rows = seed();
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.X' }] }; });

  const first = await relay.raiseEscalation({
    business: BIZ, session_id: '97250000009', question: 'אפשר לפרוס לתשלומים?', persona: { bot_gender: 'female' },
  });
  const second = await relay.raiseEscalation({
    business: BIZ, session_id: '97250000009', question: 'אז מה, אפשר או לא?', persona: { bot_gender: 'female' },
  });

  assert.ok(first.holdingLine);
  assert.ok(second.holdingLine, 'the lead is still told we are checking — the rep really does have their question');
  assert.equal(sent.length, 1, 'the rep is asked once, not once per impatient message');
  assert.equal(rows.length, 1, 'no second open row, so no second short code and no second nudge ladder');
});

test('a different lead at the same business still gets its own escalation', async () => {
  const rows = seed();
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.X' }] }; });

  await relay.raiseEscalation({ business: BIZ, session_id: '97250000009', question: 'שאלה א', persona: {} });
  await relay.raiseEscalation({ business: BIZ, session_id: '97250000008', question: 'שאלה ב', persona: {} });

  assert.equal(sent.length, 2);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.short_code), [1, 2]);
});

test('once the open escalation is answered the same lead can escalate again', async () => {
  const rows = seed();
  relay._setSenderForTest(async () => ({ messages: [{ id: 'wamid.X' }] }));
  await relay.raiseEscalation({ business: BIZ, session_id: '97250000009', question: 'שאלה א', persona: {} });
  await store.markAnswered(rows[0].id, 'כן');

  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.Y' }] }; });
  await relay.raiseEscalation({ business: BIZ, session_id: '97250000009', question: 'שאלה ב', persona: {} });

  assert.equal(sent.length, 1, 'a closed escalation must not block the lead\'s next real question');
  assert.equal(rows.length, 2);
});

// ── Guard: never message the business's own WhatsApp number ─────────────────
// The owner-contact backfill copied business_profiles.contact_phone into the
// owner row, and for two real businesses that IS the business's own WABA
// line. If the rep resolves to that same number, raiseEscalation must refuse
// to send — otherwise the bot ends up messaging (and later "replying to")
// itself.

test('refuses to relay when the rep phone equals the business\'s own WhatsApp number', async () => {
  // '0500000001' is the same number as the seeded rep's '972500000001' in a
  // different (local) format — the guard must normalize both sides.
  const rows = seed({ businessWhatsapp: '0500000001' });
  let sendCount = 0;
  relay._setSenderForTest(async () => { sendCount++; return { messages: [{ id: 'wamid.SELF' }] }; });

  const r = await relay.raiseEscalation({
    business: BIZ, session_id: '97250000009', question: 'שאלה', persona: {},
  });

  assert.equal(r, null);
  assert.equal(sendCount, 0, 'must never message the business\'s own number');
  assert.equal(rows.length, 0);
});

test('still relays when the business\'s own number differs from the rep', async () => {
  const rows = seed({ businessWhatsapp: '972599999999' });
  const sent = [];
  relay._setSenderForTest(async (msg) => { sent.push(msg); return { messages: [{ id: 'wamid.Y' }] }; });

  const r = await relay.raiseEscalation({
    business: BIZ, session_id: '97250000009', question: 'שאלה', persona: {},
  });

  assert.equal(sent.length, 1);
  assert.ok(r.holdingLine.length > 0);
  assert.equal(rows[0].status, 'open');
});

// ── Intercepting contact messages ────────────────────────────────────────────
// Rep messages arrive at the same WhatsApp number as every lead's. If the
// contact lookup below is skipped or mis-scoped, the rep's answer would be
// treated as a new lead message.

test('a contact message is consumed by the relay and never reaches the agent', async () => {
  const rows = seed();
  relay._setSenderForTest(async () => ({ messages: [{ id: 'wamid.X' }] }));
  await relay.raiseEscalation({ business: BIZ, session_id: '97250000009', question: 'שאלה', persona: {} });

  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.Y' }] }; });

  const consumed = await relay.handleContactMessage({
    business: BIZ, from: '972500000001', text: 'כן, אפשר לפרוס', contextId: 'wamid.X',
  });

  assert.equal(consumed, true);
  assert.equal(rows[0].status, 'answered');
  assert.equal(rows[0].answer, 'כן, אפשר לפרוס');
  assert.ok(sent.some(m => m.to === '97250000009'), 'the lead receives the answer');
});

test('a message from an unknown number is not consumed', async () => {
  seed();
  const consumed = await relay.handleContactMessage({
    business: BIZ, from: '972999999999', text: 'שלום', contextId: null,
  });
  assert.equal(consumed, false);
});

test('a whole-message stop closes the escalation without answering the lead', async () => {
  const rows = seed();
  relay._setSenderForTest(async () => ({ messages: [{ id: 'wamid.X' }] }));
  await relay.raiseEscalation({ business: BIZ, session_id: '97250000009', question: 'שאלה', persona: {} });

  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.Z' }] }; });
  await relay.handleContactMessage({ business: BIZ, from: '972500000001', text: 'עצור', contextId: null });

  assert.equal(rows[0].status, 'stopped');
  assert.ok(!sent.some(m => m.to === '97250000009'), 'the lead must not be messaged on stop');
});

// ── Fix round 1 — covering tests ─────────────────────────────────────────────
// sendWhatsAppMessage never throws: a Graph error or a fetch failure comes
// back as `undefined` or a truthy-but-message-less body. These tests assert
// observable state (row status/answer, who got messaged), not the send call.

test('a failed delivery to the lead does not mark the escalation answered', async () => {
  const rows = seed();
  relay._setSenderForTest(async () => ({ messages: [{ id: 'wamid.X' }] }));
  await relay.raiseEscalation({ business: BIZ, session_id: '97250000009', question: 'שאלה', persona: {} });

  const sent = [];
  relay._setSenderForTest(async (m) => {
    sent.push(m);
    // Graph rejects delivery to the lead (e.g. the 24h window expired) —
    // sendWhatsAppMessage itself never throws for this, it just returns
    // a body with no message id (or undefined on a fetch failure).
    if (m.to === '97250000009') return { error: { code: 131047 } };
    return { messages: [{ id: 'wamid.ACK' }] };
  });

  const consumed = await relay.handleContactMessage({
    business: BIZ, from: '972500000001', text: 'כן, אפשר לפרוס', contextId: 'wamid.X',
  });

  assert.equal(consumed, true);
  assert.equal(rows[0].status, 'open', 'must stay open so nudges keep working — it was never actually answered');
  assert.equal(rows[0].answer, undefined);
  assert.ok(!sent.some(m => m.to === '972500000001' && m.text === 'נשלח ✓'), 'must not ack success to the rep');
  assert.ok(sent.some(m => m.to === '972500000001' && m.text !== 'נשלח ✓'), 'the rep must be told delivery failed');
});

test('a mid-flight failure after the sender is recognised is still consumed, never falling through to the agent', async () => {
  seed();
  // findContactByPhone already succeeded by the time this throws — a
  // transient DB error here must not hand the rep's message to the
  // conversation agent.
  store._setDbForTest({
    async listOpen() { throw new Error('transient db error'); },
    async listAllOpen() { return []; },
    async insert() { throw new Error('unused in this test'); },
    async update() { throw new Error('unused in this test'); },
  });

  const consumed = await relay.handleContactMessage({
    business: BIZ, from: '972500000001', text: 'כן', contextId: null,
  });

  assert.equal(consumed, true, 'a recognised contact must never fall through to the conversation agent');
});

test('an empty body (e.g. a button tap that failed to extract text) is never relayed and leaves the escalation open', async () => {
  const rows = seed();
  relay._setSenderForTest(async () => ({ messages: [{ id: 'wamid.X' }] }));
  await relay.raiseEscalation({ business: BIZ, session_id: '97250000009', question: 'שאלה', persona: {} });

  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.ACK' }] }; });

  const consumed = await relay.handleContactMessage({
    business: BIZ, from: '972500000001', text: '', contextId: 'wamid.X',
  });

  assert.equal(consumed, true);
  assert.equal(rows[0].status, 'open', 'an empty body must not close the escalation');
  assert.equal(rows[0].answer, undefined);
  assert.ok(!sent.some(m => m.to === '97250000009'), 'the lead must never receive an empty relayed message');
  assert.ok(sent.some(m => m.to === '972500000001'), 'the rep is told the message was not understood');
});

// ── Fix round 2 — covering test ──────────────────────────────────────────────
// db.js#saveConversation writes qualification_progress ?? {} into the
// session row. If the relay doesn't pass the session's actual current
// progress through, every relayed answer silently blanks it — the bot then
// re-asks the lead things they already answered, on the very next turn.

// ── Task 7 — voice rewrite ───────────────────────────────────────────────────
// The rep's answer is authoritative: the rewrite may change tone/gender/length
// but every figure, price, date, name and commitment must survive verbatim.

test('the rewriter is given the raw human answer and its output is what the lead gets', async () => {
  const rows = seed();
  relay._setSenderForTest(async () => ({ messages: [{ id: 'wamid.X' }] }));
  await relay.raiseEscalation({ business: BIZ, session_id: '97250000009', question: 'שאלה', persona: {} });

  const seenByRewriter = [];
  relay._setRewriterForTest(async (answer) => { seenByRewriter.push(answer); return `בשמחה! ${answer}` });
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.Y' }] }; });

  await relay.handleContactMessage({ business: BIZ, from: '972500000001', text: '400 ₪ לחודש', contextId: 'wamid.X' });

  assert.deepEqual(seenByRewriter, ['400 ₪ לחודש']);
  const toLead = sent.find(m => m.to === '97250000009');
  assert.match(toLead.text, /400 ₪ לחודש/, 'the human figure must survive verbatim');
  assert.equal(rows[0].answer, '400 ₪ לחודש', 'the audit trail stores the raw human text');
});

// A normal, non-error API response whose text is simply cut off at the token
// limit must NOT be forwarded to the lead as if it were the finished rewrite —
// half a human sentence ("...בהתחייבות" truncated to "...בהתחיי") can change
// the actual commercial offer. _setRewriterForTest bypasses the real call
// entirely, so this uses the narrower _setMessagesCreateForTest seam to
// exercise the response-handling branch (the stop_reason check) directly.
test('a truncated rewrite (stop_reason: max_tokens) falls back to the ORIGINAL answer, not the cut-off text', async () => {
  const rows = seed();
  relay._setSenderForTest(async () => ({ messages: [{ id: 'wamid.X' }] }));
  await relay.raiseEscalation({ business: BIZ, session_id: '97250000009', question: 'שאלה', persona: {} });

  const original = '400 ₪ לחודש, בהתחייבות לשנה';
  relay._setRewriterForTest(null); // fall through past the wide seam into the real call path
  relay._setMessagesCreateForTest(async () => ({
    stop_reason: 'max_tokens',
    content: [{ text: '400 ₪ לחודש, בהתחיי' }], // plausible non-empty, truncated mid-word
  }));
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.Y' }] }; });

  await relay.handleContactMessage({ business: BIZ, from: '972500000001', text: original, contextId: 'wamid.X' });

  const toLead = sent.find(m => m.to === '97250000009');
  assert.equal(toLead.text, original, 'a truncated rewrite must fall back to the human\'s original words, not the cut-off text');

  relay._setMessagesCreateForTest(null); // don't leak the stub into later tests
});

test('a relayed answer preserves the session\'s existing qualification_progress rather than blanking it', async () => {
  const progress = { need: 'טיפול פנים', scope: null, budget: null, timeline: 'החודש', urgency: null };
  seed({ sessionQualificationProgress: progress });

  relay._setSenderForTest(async () => ({ messages: [{ id: 'wamid.X' }] }));
  await relay.raiseEscalation({ business: BIZ, session_id: '97250000009', question: 'שאלה', persona: {} });

  const saved = [];
  relay._setHistorySaverForTest(async (fields) => { saved.push(fields); return { status: 'success', result: {}, error: null }; });
  relay._setSenderForTest(async () => ({ messages: [{ id: 'wamid.Y' }] }));

  await relay.handleContactMessage({
    business: BIZ, from: '972500000001', text: 'כן, אפשר לפרוס', contextId: 'wamid.X',
  });

  assert.equal(saved.length, 1, 'the relayed exchange must be recorded');
  assert.deepEqual(saved[0].qualification_progress, progress,
    'must pass the session\'s existing progress through unchanged, not {} or undefined');
});

// ── I4: the contact lookup itself failing must also fail closed ──────────────
// handleContactMessage already consumes a mid-flight failure AFTER the sender
// is recognised. But if findContactByPhone is what throws, `recognized` was
// still false, so the message went to the conversation agent — the bot pitches
// its own rep and files them in the client's lead inbox. A lookup ERROR is not
// evidence that the sender is a lead; it is evidence that we do not know.

test('a contact lookup that throws is consumed, never handed to the conversation agent', async () => {
  contacts._setDbForTest({
    async listContacts() { throw new Error('transient db error'); },
    async upsertContact() {},
  });

  const consumed = await relay.handleContactMessage({
    business: BIZ, from: '972500000001', text: 'כן, אפשר', contextId: null,
  });

  assert.equal(consumed, true, 'not knowing whether the sender is a rep must never resolve to "sell to them"');
});

// ── I5: the rep must know WHO is asking ──────────────────────────────────────
// conversation.js passed `summary: context.contact_summary` — a key nothing in
// the repo ever sets — and no leadName at all, so templateParam's "—"
// placeholder rendered for {{2}} and {{3}} on EVERY escalation, not just for an
// anonymous lead. The rep got a bare question from nobody. Design spec §2
// requires the contacts.ai_summary snapshot with a fallback to recent turns,
// and this has to be right BEFORE the templates go to Meta: the approved body
// is written around these parameters.

const HISTORY = [
  { role: 'user',      content: 'היי, כמה עולה טיפול פנים?' },
  { role: 'assistant', content: 'שמחה שפנית! מה בדיוק מעניין אותך?' },
  { role: 'user',      content: 'ניקוי עמוק, ואפשר לפרוס לתשלומים?' },
];

test('the rep is told the lead\'s name and the ai_summary snapshot', async () => {
  seed({ leadContact: { name: 'דנה כהן', ai_summary: 'מתעניינת בטיפול פנים, שאלה על מחירים בעבר.' } });
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.X' }] }; });

  await relay.raiseEscalation({
    business: BIZ, session_id: '97250000009', question: 'אפשר לפרוס לתשלומים?',
    history: HISTORY, persona: { bot_gender: 'female' },
  });

  assert.match(sent[0].text, /דנה כהן/, 'the rep must know who is asking');
  assert.match(sent[0].text, /מתעניינת בטיפול פנים/, 'the ai_summary snapshot must reach the rep');
  assert.ok(!sent[0].text.includes('סיכום: —'), 'the placeholder must not render when a real summary exists');
});

test('a lead with no ai_summary yet falls back to the recent turns', async () => {
  const rows = seed({ leadContact: { name: 'דנה כהן', ai_summary: null } });
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.X' }] }; });

  await relay.raiseEscalation({
    business: BIZ, session_id: '97250000009', question: 'אפשר לפרוס לתשלומים?',
    history: HISTORY, persona: {},
  });

  // ai_summary is generated asynchronously (index.js:378), so on a
  // first-message escalation it is null or stale — spec §2 says fall back to
  // the last few turns rather than sending the rep an empty summary.
  assert.match(sent[0].text, /ניקוי עמוק/, 'the rep must see what the lead has actually been saying');
  assert.match(rows[0].summary, /ניקוי עמוק/, 'the snapshot is stored on the row, not just sent');
});

test('an anonymous lead with no history still escalates, placeholder and all', async () => {
  seed({ leadContact: null });
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.X' }] }; });

  const r = await relay.raiseEscalation({
    business: BIZ, session_id: '97250000009', question: 'אפשר לפרוס לתשלומים?', persona: {},
  });

  assert.ok(r.holdingLine, 'an unknown lead must never block the escalation');
  assert.match(sent[0].text, /אפשר לפרוס לתשלומים\?/);
});

test('a contacts lookup failure degrades the rep message instead of killing the escalation', async () => {
  const rows = seed({ leadContact: undefined }); // getLeadContact throws
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.X' }] }; });

  const r = await relay.raiseEscalation({
    business: BIZ, session_id: '97250000009', question: 'אפשר לפרוס לתשלומים?',
    history: HISTORY, persona: {},
  });

  assert.ok(r.holdingLine, 'a cosmetic lookup must never cost the lead their escalation');
  assert.equal(rows[0].status, 'open');
  assert.match(sent[0].text, /ניקוי עמוק/, 'the history fallback still supplies a summary');
});

test('an explicitly passed leadName and summary win over the lookup', async () => {
  seed({ leadContact: { name: 'לא נכון', ai_summary: 'לא נכון' } });
  const sent = [];
  relay._setSenderForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.X' }] }; });

  await relay.raiseEscalation({
    business: BIZ, session_id: '97250000009', question: 'שאלה',
    leadName: 'דנה כהן', summary: 'סיכום מפורש', persona: {},
  });

  assert.match(sent[0].text, /דנה כהן/);
  assert.match(sent[0].text, /סיכום מפורש/);
});
