// server/test/booster-webhook-meeting.test.js
//
// T2 (funnel track 1) — the meeting events (send_signed_summary /
// send_meeting_reminder) now carry REAL calendar slots in the SAME WhatsApp
// message (one send, never a follow-up), and record a meeting_invite note so
// the booking gate can later name the event after the order (F5).
// Failure discipline: any slot problem — fetch error, empty list, a hang cut
// off by the internal ~2.5s budget — degrades to today's copy, never a lost
// message. Separate file from booster-webhook.test.js: the route's in-memory
// dedup Set persists per process, so every test here uses fresh event_ids.
process.env.SUPABASE_URL = 'http://supabase.invalid';
process.env.SUPABASE_SERVICE_KEY = 'stub-service-key';
process.env.BOT_WEBHOOK_SECRET = 'test-secret-0123456789abcdef';
process.env.DIVAZ_BUSINESS_ID = 'biz-diva-test';
process.env.MODULE_SECRETS_KEY = Buffer.alloc(32).toString('base64');

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const { default: boosterWebhookRouter, _setSendForTest, _setSlotsFetcherForTest } =
  await import('../routes/booster-webhook.js');
const meeting = await import('../lib/booster-meeting.js');
const engine = await import('../lib/modules/engine.js');

function startServer() {
  const app = express();
  app.use(express.json());
  app.use(boosterWebhookRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function post(server, body) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/booster-webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.BOT_WEBHOOK_SECRET}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const lead = { name: 'PWTEST Lead', phone: '0520000000' };
const body = (event_id, event, payload) => ({ event_id, lead_id: 'PWTEST-lead', event, payload, lead });

const SLOTS = [
  { date: '2026-08-10', from: '10:00', to: '10:30' },
  { date: '2026-08-10', from: '10:30', to: '11:00' },
  { date: '2026-08-11', from: '12:00', to: '12:30' },
];

function freshMeetingDb() {
  const db = { events: [] };
  meeting._setDbForTest(db);
  return db;
}

test.afterEach(() => {
  _setSendForTest(null);
  _setSlotsFetcherForTest(null);
  meeting._setDbForTest(null);
  engine._setDbForTest(null);
});

test('send_signed_summary: real slots ride the SAME message — one send — and a meeting_invite is recorded', async () => {
  const server = await startServer();
  const db = freshMeetingDb();
  const sent = [];
  _setSendForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.OK' }] }; });
  _setSlotsFetcherForTest(async () => SLOTS);
  try {
    const r = await post(server, body('evt-mtg-signed-1', 'send_signed_summary', { quote_number: 'DZ-2026-1042', total: 750 }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });

    assert.equal(sent.length, 1, 'the offer must ride the same message, never a second send');
    assert.match(sent[0].text, /נחתמה/, 'the existing signed-summary copy is kept');
    assert.match(sent[0].text, /2026-08-10.*10:00, 10:30/, 'real slots appear in the same text');
    assert.match(sent[0].text, /2026-08-11.*12:00/);

    const invite = db.events.find(e => e.event_type === 'meeting_invite');
    assert.ok(invite, 'a meeting_invite note must be recorded for the gate/title fallback (F5)');
    assert.equal(invite.detail.phone, '0520000000');
    assert.equal(invite.detail.quote_number, 'DZ-2026-1042');
    assert.equal(invite.business_id, 'biz-diva-test');
  } finally {
    server.close();
  }
});

test('send_meeting_reminder also carries the slot offer and records an invite', async () => {
  const server = await startServer();
  const db = freshMeetingDb();
  const sent = [];
  _setSendForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.OK' }] }; });
  _setSlotsFetcherForTest(async () => SLOTS);
  try {
    const r = await post(server, body('evt-mtg-remind-1', 'send_meeting_reminder', { quote_number: 'DZ-2026-1042' }));
    assert.equal(r.status, 200);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /תזכורת/);
    assert.match(sent[0].text, /2026-08-10.*10:00/);
    assert.ok(db.events.some(e => e.event_type === 'meeting_invite'));
  } finally {
    server.close();
  }
});

test('slot fetch failure (or an empty calendar) → today\'s copy is sent unchanged, still one 200', async () => {
  const server = await startServer();
  freshMeetingDb();
  const sent = [];
  _setSendForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.OK' }] }; });

  _setSlotsFetcherForTest(async () => { throw new Error('calendar down'); });
  try {
    const failed = await post(server, body('evt-mtg-fail-1', 'send_signed_summary', { quote_number: 'DZ-1', total: 100 }));
    assert.equal(failed.status, 200);
    assert.deepEqual(failed.json, { ok: true }, 'a slot problem must never fail the delivery');
    assert.match(sent[0].text, /נחתמה/);
    assert.doesNotMatch(sent[0].text, /2026-08-10/, 'no invented slot lines');

    _setSlotsFetcherForTest(async () => []);
    await post(server, body('evt-mtg-empty-1', 'send_signed_summary', { quote_number: 'DZ-1', total: 100 }));
    assert.doesNotMatch(sent[1].text, /מועדים פנויים/, 'an empty calendar adds nothing');
  } finally {
    server.close();
  }
});

test('a slot fetch that hangs is cut off by the internal budget and the existing copy still goes out', async () => {
  const server = await startServer();
  freshMeetingDb();
  const sent = [];
  _setSendForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.OK' }] }; });
  _setSlotsFetcherForTest(() => new Promise(() => {})); // never settles
  try {
    const started = Date.now();
    const r = await post(server, body('evt-mtg-hang-1', 'send_signed_summary', { quote_number: 'DZ-1', total: 100 }));
    const elapsed = Date.now() - started;
    assert.equal(r.status, 200);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /נחתמה/);
    assert.ok(elapsed < 5500, `the internal ~2.5s budget must keep the route inside the booster 8s SLA (took ${elapsed}ms)`);
  } finally {
    server.close();
  }
});

test('a non-meeting event never touches the slot fetcher and records nothing', async () => {
  const server = await startServer();
  const db = freshMeetingDb();
  let fetches = 0;
  _setSendForTest(async () => ({ messages: [{ id: 'wamid.OK' }] }));
  _setSlotsFetcherForTest(async () => { fetches++; return SLOTS; });
  try {
    await post(server, body('evt-mtg-other-1', 'send_personal_link', { link_url: 'https://x/y', valid_days: 14 }));
    assert.equal(fetches, 0);
    assert.equal(db.events.length, 0);
  } finally {
    server.close();
  }
});

test('the real fetcher reads Diva\'s connected calendar module (fake provider) end-to-end', async () => {
  // No fetcher stub: the route walks engine → registry → calendar module.
  // A 'fake'-provider row makes computeCurrentSlots real but network-free.
  const server = await startServer();
  const db = freshMeetingDb();
  engine._setDbForTest({
    enabledRows: [{
      business_id: 'biz-diva-test', module_key: 'calendar', enabled: true, status: 'connected',
      secrets: {},
      settings: {
        provider: 'fake', mode: 'autonomous', duration_min: 30, buffer_min: 0,
        horizon_days: 7, min_notice_hours: 0,
        weekly: {
          sun: [{ from: '10:00', to: '12:00' }], mon: [{ from: '10:00', to: '12:00' }],
          tue: [{ from: '10:00', to: '12:00' }], wed: [{ from: '10:00', to: '12:00' }],
          thu: [{ from: '10:00', to: '12:00' }], fri: [{ from: '10:00', to: '12:00' }],
          sat: [{ from: '10:00', to: '12:00' }],
        },
        overrides: {}, jewish_holidays_closed: false,
      },
    }],
  });
  const sent = [];
  _setSendForTest(async (m) => { sent.push(m); return { messages: [{ id: 'wamid.OK' }] }; });
  try {
    const r = await post(server, body('evt-mtg-real-1', 'send_signed_summary', { quote_number: 'DZ-9', total: 100 }));
    assert.equal(r.status, 200);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /פגישת האפיון/);
    assert.match(sent[0].text, /\d{4}-\d{2}-\d{2}.*\d{2}:\d{2}/, 'real computed slots appear');
    assert.ok(db.events.some(e => e.event_type === 'meeting_invite'));
  } finally {
    server.close();
  }
});
