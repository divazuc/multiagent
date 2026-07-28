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
function seed({ rep = { business_id: 'b1', role: 'rep', name: 'סאלי', phone: '972500000001' }, businessWhatsapp = null } = {}) {
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
    async getBusiness() { return { whatsapp_number: businessWhatsapp }; },
  });
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
