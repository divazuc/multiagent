// server/test/meeting-approval.test.js
//
// Telegram one-tap approval for tentative (owner_confirmed) bookings:
//   · the approval record stores ONLY a SHA-256 hash of the token
//   · requestOwnerApproval: Telegram primary, the pre-Telegram WhatsApp owner
//     notify as fallback for a missing env or any Telegram failure
//   · GET /meeting/:token is side-effect-free (Telegram prefetches links)
//   · approve: title prefix stripped, attendee added only when the client
//     e-mail is known (sendUpdates:'all'), meeting_booked recorded, client
//     messaged, token consumed exactly once
//   · reschedule: event deleted, the one-meeting hold RELEASED (a new booking
//     attempt passes the gate), current slots re-offered
//   · expired/invalid tokens: 404-style Hebrew page, zero side effects
// Same seam conventions as booster-gate-wiring.test.js — in-memory stores,
// fake provider, stubbed sends; never a network call.
process.env.SUPABASE_URL = 'http://supabase.invalid';
process.env.SUPABASE_SERVICE_KEY = 'stub-service-key';
process.env.MODULE_SECRETS_KEY = Buffer.alloc(32).toString('base64');

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';

const approval = await import('../lib/meeting-approval.js');
const meeting = await import('../lib/booster-meeting.js');
const engine = await import('../lib/modules/engine.js');
const calendarMod = await import('../lib/modules/calendar/index.js');
const { default: meetingRouter, _setSendForTest } = await import('../routes/meeting-approval.js');

const BIZ_ID = 'biz-appr-test';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const pad = (n) => String(n).padStart(2, '0');
// Two days out at 10:00 — always in the future, whatever the wall clock says.
const futureSlot = () => {
  const d = new Date(Date.now() + 48 * 3600 * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T10:00`;
};

const HOURS = [{ from: '10:00', to: '14:00' }];
const calRow = (settings = {}) => ({
  business_id: BIZ_ID, module_key: 'calendar', enabled: true, status: 'connected', secrets: {},
  settings: {
    provider: 'fake', mode: 'owner_confirmed', duration_min: 30, buffer_min: 0,
    horizon_days: 7, min_notice_hours: 0,
    weekly: { sun: HOURS, mon: HOURS, tue: HOURS, wed: HOURS, thu: HOURS, fri: HOURS, sat: HOURS },
    overrides: {}, jewish_holidays_closed: false, event_title: 'פגישה — {name}',
    ...settings,
  },
});

function seedStores({ calSettings = {} } = {}) {
  const approvals = { events: [] };
  approval._setDbForTest(approvals);
  const notes = { events: [] };
  meeting._setDbForTest(notes);
  engine._setDbForTest({ enabledRows: [calRow(calSettings)], onEvent: () => {} });
  return { approvals, notes };
}

function recordingProvider(overrides = {}) {
  const calls = { getEvent: [], patchEvent: [], deleteEvent: [] };
  calendarMod._setProviderForTest({
    freeBusy: async () => [],
    createEvent: async () => ({ eventId: 'ev-x', htmlLink: '' }),
    getEvent: async (_s, id) => { calls.getEvent.push(id); return { eventId: id, title: '⏳ ממתין לאישור: פגישת אפיון — הזמנה DZ-1', attendees: [] }; },
    patchEvent: async (_s, id, patch, opts) => { calls.patchEvent.push({ id, patch, opts }); },
    deleteEvent: async (_s, id) => { calls.deleteEvent.push(id); },
    ...overrides,
  });
  return calls;
}

function startServer() {
  const app = express();
  app.use(meetingRouter);
  return new Promise((resolve) => { const server = app.listen(0, () => resolve(server)); });
}

async function hit(server, path, method = 'GET') {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  return { status: res.status, html: await res.text() };
}

const TG_ENV = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'PUBLIC_BASE_URL'];
const savedEnv = {};
test.beforeEach(() => { for (const k of TG_ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; } });
test.afterEach(() => {
  for (const k of TG_ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  approval._setDbForTest(null);
  approval._setTelegramFetchForTest(null);
  approval._setWaSendForTest(null);
  meeting._setDbForTest(null);
  meeting._setBoosterClientForTest(null);
  engine._setDbForTest(null);
  calendarMod._setProviderForTest(null);
  _setSendForTest(null);
});

// ── The approval store ───────────────────────────────────────────────────────

test('createMeetingApproval stores a SHA-256 hash — the raw token appears nowhere in the record', async () => {
  const { approvals } = seedStores();
  const token = await approval.createMeetingApproval({
    businessId: BIZ_ID, eventId: 'ev-1', calendarRowId: null,
    phone: '972521234567', name: 'דנה כהן', slot: futureSlot(), quoteNumber: 'DZ-1', clientEmail: null,
  });
  assert.ok(token && token.length >= 40, '32 random bytes base64url');
  assert.equal(approvals.events.length, 1);
  const row = approvals.events[0];
  assert.equal(row.event_type, 'meeting_approval');
  assert.equal(row.detail.token_hash, sha256(token));
  assert.equal(row.detail.status, 'pending');
  assert.equal(row.detail.phone, '0521234567', 'stored in the normalized 05… form');
  assert.ok(!JSON.stringify(row).includes(token), 'the raw token must never be persisted');
  const found = await approval.findApprovalByToken(token);
  assert.equal(found, row, 'the raw token finds its record through the hash');
  assert.equal(await approval.findApprovalByToken('not-the-token-aaaaaaaaaaaaaaaa'), null);
});

// ── requestOwnerApproval: Telegram primary, WhatsApp fallback ────────────────

test('with Telegram configured: one message with the details and both one-tap links, no WhatsApp', async () => {
  const { approvals } = seedStores();
  process.env.TELEGRAM_BOT_TOKEN = 'tg-stub-token';
  process.env.TELEGRAM_CHAT_ID = '12345';
  process.env.PUBLIC_BASE_URL = 'https://bot.example';
  const tg = [];
  approval._setTelegramFetchForTest(async (url, init) => { tg.push({ url, body: JSON.parse(init.body) }); return { ok: true }; });
  const wa = [];
  approval._setWaSendForTest(async (m) => { wa.push(m); });

  const slot = futureSlot();
  const via = await approval.requestOwnerApproval({
    business: { id: BIZ_ID, name: 'Diva Ost' }, calendarRowId: null, ownerNotifyPhone: '0509999999',
    eventId: 'ev-1', phone: '972521234567', name: 'דנה כהן', slot, quoteNumber: 'DZ-2026-1042', clientEmail: null,
  });

  assert.equal(via, 'telegram');
  assert.equal(wa.length, 0, 'Telegram delivered — the WhatsApp fallback must stay quiet');
  assert.equal(tg.length, 1);
  assert.ok(tg[0].url.includes('/bottg-stub-token/sendMessage'));
  assert.equal(tg[0].body.chat_id, '12345');
  const text = tg[0].body.text;
  assert.match(text, /דנה כהן/);
  assert.match(text, /0521234567/, 'the phone is shown in the normalized 05… form');
  assert.match(text, /DZ-2026-1042/);
  assert.match(text, new RegExp(`בשעה ${slot.split('T')[1]}`));
  assert.match(text, /אישור: https:\/\/bot\.example\/meeting\//);
  assert.match(text, /שינוי מועד: https:\/\/bot\.example\/meeting\//);
  const token = text.match(/\/meeting\/([A-Za-z0-9_-]+)/)[1];
  assert.equal(approvals.events[0].detail.token_hash, sha256(token),
    'the links carry the exact token whose hash was stored');
});

test('Telegram env absent: the pre-Telegram WhatsApp owner notify goes out instead, no approval record', async () => {
  const { approvals } = seedStores();
  const wa = [];
  approval._setWaSendForTest(async (m) => { wa.push(m); });
  const via = await approval.requestOwnerApproval({
    business: { id: BIZ_ID, name: 'Diva Ost' }, calendarRowId: null, ownerNotifyPhone: '0509999999',
    eventId: 'ev-1', phone: '0521234567', name: 'דנה', slot: '2026-08-12T10:00', quoteNumber: null, clientEmail: null,
  });
  assert.equal(via, 'whatsapp');
  assert.equal(approvals.events.length, 0, 'a token nobody will ever receive is not created');
  assert.equal(wa.length, 1);
  assert.equal(wa[0].to, '0509999999');
  assert.equal(wa[0].text,
    '📅 בקשת פגישה חדשה: דנה (0521234567) — 2026-08-12 בשעה 10:00. האירוע ביומן מסומן "ממתין לאישור".',
    'the fallback keeps the original owner-notify copy byte-for-byte');
});

test('a Telegram failure falls back to WhatsApp and never throws into the booking path', async () => {
  seedStores();
  process.env.TELEGRAM_BOT_TOKEN = 'tg-stub-token';
  process.env.TELEGRAM_CHAT_ID = '12345';
  approval._setTelegramFetchForTest(async () => { throw new Error('telegram down'); });
  const wa = [];
  approval._setWaSendForTest(async (m) => { wa.push(m); });
  const via = await approval.requestOwnerApproval({
    business: { id: BIZ_ID, name: 'Diva Ost' }, calendarRowId: null, ownerNotifyPhone: '0509999999',
    eventId: 'ev-1', phone: '0521234567', name: 'דנה', slot: '2026-08-12T10:00', quoteNumber: null, clientEmail: null,
  });
  assert.equal(via, 'whatsapp');
  assert.equal(wa.length, 1, 'the owner still hears about the request');
});

// ── The public routes ────────────────────────────────────────────────────────

async function seedApproval({ calSettings, clientEmail = null, slot = futureSlot(), quoteNumber = 'DZ-1' } = {}) {
  const stores = seedStores({ calSettings });
  const token = await approval.createMeetingApproval({
    businessId: BIZ_ID, eventId: 'ev-77', calendarRowId: null,
    phone: '972521234567', name: 'דנה כהן', slot, quoteNumber, clientEmail,
  });
  return { ...stores, token, slot };
}

test('GET /meeting/:token shows the request with both buttons and causes zero side effects', async () => {
  const { token, approvals, notes } = await seedApproval();
  const calls = recordingProvider();
  const sent = [];
  _setSendForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.OK' }] }; });
  const server = await startServer();
  try {
    const r = await hit(server, `/meeting/${token}`);
    assert.equal(r.status, 200);
    assert.match(r.html, /dir="rtl"/);
    assert.match(r.html, /דנה כהן/);
    assert.match(r.html, /0521234567/);
    assert.match(r.html, /DZ-1/);
    assert.match(r.html, new RegExp(`action="/meeting/${token}/approve"`));
    assert.match(r.html, new RegExp(`action="/meeting/${token}/reschedule"`));
    // Telegram prefetches every link it shows — a GET with side effects would
    // approve meetings nobody tapped.
    assert.equal(calls.getEvent.length + calls.patchEvent.length + calls.deleteEvent.length, 0);
    assert.equal(sent.length, 0);
    assert.equal(approvals.events[0].detail.status, 'pending');
    assert.equal(notes.events.length, 0);
  } finally {
    server.close();
  }
});

test('approve: prefix stripped, attendee added (e-mail known), sendUpdates all, note written, client told, token consumed', async () => {
  const { token, approvals, notes, slot } = await seedApproval({ clientEmail: 'dana@example.com' });
  const calls = recordingProvider();
  const sent = [];
  _setSendForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.OK' }] }; });
  const server = await startServer();
  try {
    const r = await hit(server, `/meeting/${token}/approve`, 'POST');
    assert.equal(r.status, 200);
    assert.match(r.html, /הפגישה אושרה/);

    assert.deepEqual(calls.getEvent, ['ev-77']);
    assert.equal(calls.patchEvent.length, 1);
    const { id, patch, opts } = calls.patchEvent[0];
    assert.equal(id, 'ev-77');
    assert.equal(patch.title, 'פגישת אפיון — הזמנה DZ-1', 'the ⏳ pending prefix is gone');
    assert.deepEqual(patch.attendees, [{ email: 'dana@example.com' }]);
    assert.equal(opts.sendUpdates, 'all', 'this is what makes Google e-mail the invite');

    const booked = notes.events.filter(e => e.event_type === 'meeting_booked');
    assert.equal(booked.length, 1, 'the confirmed note — also suppresses the booster 3-day reminder');
    assert.equal(booked[0].detail.phone, '0521234567');
    assert.equal(booked[0].detail.quote_number, 'DZ-1');
    assert.equal(booked[0].detail.slot, slot);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, '972521234567');
    assert.match(sent[0].text, /הפגישה אושרה! 🎉/);
    assert.match(sent[0].text, new RegExp(`בשעה ${slot.split('T')[1]}`));
    assert.match(sent[0].text, /שלחתי לך זימון למייל 📧/);

    assert.equal(approvals.events[0].detail.status, 'approved');

    // Single-use: the second tap changes nothing.
    const again = await hit(server, `/meeting/${token}/approve`, 'POST');
    assert.match(again.html, /כבר טופל/);
    assert.equal(calls.patchEvent.length, 1);
    assert.equal(sent.length, 1);
    assert.equal(notes.events.filter(e => e.event_type === 'meeting_booked').length, 1);
  } finally {
    server.close();
  }
});

test('approve with no client e-mail: no attendees patched, no e-mail sentence to the client', async () => {
  const { token } = await seedApproval({ clientEmail: null });
  const calls = recordingProvider();
  const sent = [];
  _setSendForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.OK' }] }; });
  const server = await startServer();
  try {
    const r = await hit(server, `/meeting/${token}/approve`, 'POST');
    assert.equal(r.status, 200);
    assert.equal(calls.patchEvent.length, 1);
    assert.equal(calls.patchEvent[0].patch.attendees, undefined, 'no address — no attendee to invite');
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /הפגישה אושרה! 🎉/);
    assert.doesNotMatch(sent[0].text, /מייל/, 'no invite went out — the copy must not promise one');
  } finally {
    server.close();
  }
});

test('reschedule: event deleted, hold released end-to-end (the gate passes again), slots re-offered, consumed', async () => {
  const { token, approvals, notes } = await seedApproval();
  // The gate needs the booster module + a lead to guard — seed both so the
  // release can be proven END-TO-END rather than by inspecting rows.
  engine._setDbForTest({
    enabledRows: [
      calRow(),
      { business_id: BIZ_ID, module_key: 'booster', enabled: true, status: 'connected', secrets: {}, settings: {} },
    ],
    onEvent: () => {},
  });
  meeting._setBoosterClientForTest({
    lookupBoosterLeadByPhone: async () => ({ leadId: 'l1', name: 'דנה כהן', status: 'awaiting_meeting' }),
  });
  await meeting.recordMeetingInvite({ businessId: BIZ_ID, phone: '0521234567', quoteNumber: 'DZ-1' });
  await meeting.recordMeetingRequested({ businessId: BIZ_ID, phone: '0521234567', quoteNumber: 'DZ-1', slot: futureSlot() });

  const gateArgs = {
    business: { id: BIZ_ID, name: 'Diva Ost' },
    action: { module: 'calendar', name: 'book', payload: { slot: futureSlot(), name: 'דנה' } },
    sessionCtx: { session_id: '972521234567' },
  };
  assert.equal((await meeting.gateCalendarBooking(gateArgs)).allow, false,
    'sanity: before the reschedule the pending request holds the one meeting');

  const calls = recordingProvider();
  const sent = [];
  _setSendForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.OK' }] }; });
  const server = await startServer();
  try {
    const r = await hit(server, `/meeting/${token}/reschedule`, 'POST');
    assert.equal(r.status, 200);
    assert.match(r.html, /המועד שוחרר/);

    assert.deepEqual(calls.deleteEvent, ['ev-77'], 'the tentative event is off the calendar');
    assert.equal(calls.patchEvent.length, 0);

    assert.equal(notes.events.filter(e => e.event_type === 'meeting_request_cancelled').length, 1);
    assert.equal((await meeting.gateCalendarBooking(gateArgs)).allow, true,
      'the release is real: a new booking attempt passes the gate');

    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, '972521234567');
    assert.match(sent[0].text, /המועד הזה כבר לא מסתדר 🙏/);
    assert.match(sent[0].text, /מועדים פנויים/, 'the CURRENT free slots ride the same message');
    assert.match(sent[0].text, /\d{4}-\d{2}-\d{2}: \d{2}:\d{2}/, 'real computed slots, not invented ones');

    assert.equal(approvals.events[0].detail.status, 'rescheduled');

    const again = await hit(server, `/meeting/${token}/reschedule`, 'POST');
    assert.match(again.html, /כבר טופל/);
    assert.equal(calls.deleteEvent.length, 1);
    assert.equal(sent.length, 1);
  } finally {
    server.close();
  }
});

test('reschedule with an empty calendar: the owner-named callback line instead of invented slots', async () => {
  const { token } = await seedApproval({
    calSettings: { weekly: { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] }, owner_display_name: 'דיוה' },
  });
  recordingProvider();
  const sent = [];
  _setSendForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.OK' }] }; });
  const server = await startServer();
  try {
    await hit(server, `/meeting/${token}/reschedule`, 'POST');
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /המועד הזה כבר לא מסתדר 🙏/);
    assert.match(sent[0].text, /דיוה תחזור אליך לתיאום/);
    assert.doesNotMatch(sent[0].text, /מועדים פנויים/, 'no free slots — none may be offered');
  } finally {
    server.close();
  }
});

test('an invalid token and an expired slot both get a 404-style Hebrew page with zero side effects', async () => {
  const { approvals, notes } = seedStores();
  const expiredToken = await approval.createMeetingApproval({
    businessId: BIZ_ID, eventId: 'ev-old', calendarRowId: null,
    phone: '0521234567', name: 'דנה', slot: '2020-01-01T10:00', quoteNumber: 'DZ-0', clientEmail: null,
  });
  const calls = recordingProvider();
  const sent = [];
  _setSendForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.OK' }] }; });
  const server = await startServer();
  try {
    for (const path of [
      '/meeting/definitely-not-a-real-token-aaaa',
      `/meeting/${expiredToken}`,
    ]) {
      const got = await hit(server, path);
      assert.equal(got.status, 404, `${path} must 404`);
      assert.match(got.html, /הקישור לא בתוקף/);
    }
    for (const action of ['approve', 'reschedule']) {
      const bad = await hit(server, `/meeting/definitely-not-a-real-token-aaaa/${action}`, 'POST');
      assert.equal(bad.status, 404);
      const expired = await hit(server, `/meeting/${expiredToken}/${action}`, 'POST');
      assert.equal(expired.status, 404, 'a token whose slot already started is dead — either action refuses');
    }
    assert.equal(calls.getEvent.length + calls.patchEvent.length + calls.deleteEvent.length, 0);
    assert.equal(sent.length, 0);
    assert.equal(notes.events.length, 0);
    assert.equal(approvals.events[0].detail.status, 'pending', 'expiry never rewrites the record');
  } finally {
    server.close();
  }
});
