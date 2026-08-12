// server/test/daily-scheduler.test.js
//
// lib/daily-scheduler.js — the owner-in-the-loop 09:00 Asia/Jerusalem
// Telegram notice: fires once/day, boot-recovery inside the 09:00 window,
// DST-proof (no hardcoded UTC offset), no-trials → no Telegram, fail-soft
// across businesses. No WhatsApp is ever sent from this module.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ds = await import('../lib/daily-scheduler.js');
const approvals = await import('../lib/approvals.js');

const BIZ = 'biz-ck';
const TODAY = '2026-08-12';
// 06:05 UTC = 09:05 Asia/Jerusalem in August (IDT, UTC+3)
const IN_WINDOW_SUMMER = new Date('2026-08-12T06:05:00.000Z');
// Same day, same 09:xx hour, later — should be a no-op (already fired today)
const LATER_SAME_WINDOW = new Date('2026-08-12T06:40:00.000Z');
// 10:05 UTC = 13:05 IDT — well outside the fire hour
const OUTSIDE_WINDOW = new Date('2026-08-12T10:05:00.000Z');
// Winter check (IST, UTC+2): 07:05 UTC = 09:05 IST
const IN_WINDOW_WINTER = new Date('2026-01-12T07:05:00.000Z');

function armTelegram() {
  process.env.TELEGRAM_BOT_TOKEN = 'tg-token';
  process.env.TELEGRAM_CHAT_ID = '12345';
  const sent = [];
  approvals._setTelegramFetchForTest(async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    return { ok: true };
  });
  return sent;
}

test.afterEach(() => {
  ds._resetForTest();
  ds._setDbForTest(null);
  ds._setPreviewForTest(null);
  ds.stopDailyScheduler();
  approvals._setTelegramFetchForTest(null);
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  delete process.env.STUDIO_BASE_URL;
});

test('outside the 09:00 local hour, the tick does nothing at all — no db call, no Telegram', async () => {
  let calls = 0;
  ds._setDbForTest({ listLeadsEnabledBusinesses: async () => { calls++; return []; } });
  const tg = armTelegram();
  await ds._tickForTest(OUTSIDE_WINDOW);
  assert.equal(calls, 0);
  assert.equal(tg.length, 0);
});

test('a leads-enabled business with no trials today gets no Telegram notice', async () => {
  ds._setDbForTest({ listLeadsEnabledBusinesses: async () => [{ business_id: BIZ, name: 'קרוספיט קידס' }] });
  ds._setPreviewForTest(async () => ({ date: TODAY, mode: 'live', leads: [] }));
  const tg = armTelegram();
  await ds._tickForTest(IN_WINDOW_SUMMER);
  assert.equal(tg.length, 0);
});

test('a business with trial signups today gets ONE Telegram message: count, names/times, studio link', async () => {
  ds._setDbForTest({ listLeadsEnabledBusinesses: async () => [{ business_id: BIZ, name: 'קרוספיט קידס' }] });
  ds._setPreviewForTest(async () => ({
    date: TODAY, mode: 'live',
    leads: [
      { id: 'l-1', phone: '972501234567', child_name: 'יובל', trial_time: '16:00' },
      { id: 'l-2', phone: '972502222222', child_name: null, display_name: 'משפחת כהן', trial_time: '17:00' },
    ],
  }));
  const tg = armTelegram();
  await ds._tickForTest(IN_WINDOW_SUMMER);
  assert.equal(tg.length, 1);
  assert.ok(tg[0].text.includes('2 נרשמו'));
  assert.ok(tg[0].text.includes('יובל'));
  assert.ok(tg[0].text.includes('16:00'));
  assert.ok(tg[0].text.includes('משפחת כהן'));
  assert.ok(tg[0].text.includes('demo.html?biz=biz-ck'));
  assert.ok(tg[0].text.includes('view=leads'));
  assert.ok(tg[0].text.includes('remind=1'));
  assert.equal(tg[0].chat_id, '12345');
});

test('fires once per day: a second tick inside the same 09:xx window sends nothing more', async () => {
  ds._setDbForTest({ listLeadsEnabledBusinesses: async () => [{ business_id: BIZ, name: 'B' }] });
  ds._setPreviewForTest(async () => ({ date: TODAY, mode: 'live', leads: [{ id: 'l-1', phone: '972501234567', trial_time: '10:00' }] }));
  const tg = armTelegram();
  await ds._tickForTest(IN_WINDOW_SUMMER);
  assert.equal(tg.length, 1);
  await ds._tickForTest(LATER_SAME_WINDOW);
  assert.equal(tg.length, 1); // no second notice, same local day
});

test('boot-recovery: the FIRST tick landing anywhere inside 09:00–09:59 still fires (mid-window restart)', async () => {
  ds._setDbForTest({ listLeadsEnabledBusinesses: async () => [{ business_id: BIZ, name: 'B' }] });
  ds._setPreviewForTest(async () => ({ date: TODAY, mode: 'live', leads: [{ id: 'l-1', phone: '972501234567', trial_time: '10:00' }] }));
  const tg = armTelegram();
  await ds._tickForTest(LATER_SAME_WINDOW); // 09:40 — no prior tick today, still fires
  assert.equal(tg.length, 1);
});

test('a NEW day resets the gate: yesterday firing does not block today', async () => {
  ds._setLastFiredForTest('2026-08-11');
  ds._setDbForTest({ listLeadsEnabledBusinesses: async () => [{ business_id: BIZ, name: 'B' }] });
  ds._setPreviewForTest(async () => ({ date: TODAY, mode: 'live', leads: [{ id: 'l-1', phone: '972501234567', trial_time: '10:00' }] }));
  const tg = armTelegram();
  await ds._tickForTest(IN_WINDOW_SUMMER);
  assert.equal(tg.length, 1);
});

test('DST-proof: also fires at 09:00 local in winter (IST, UTC+2) — never a hardcoded UTC offset', async () => {
  ds._setDbForTest({ listLeadsEnabledBusinesses: async () => [{ business_id: BIZ, name: 'B' }] });
  ds._setPreviewForTest(async () => ({ date: '2026-01-12', mode: 'live', leads: [{ id: 'l-1', phone: '972501234567', trial_time: '10:00' }] }));
  const tg = armTelegram();
  await ds._tickForTest(IN_WINDOW_WINTER);
  assert.equal(tg.length, 1);
});

test('fail-soft: one business erroring does not stop the others or throw', async () => {
  ds._setDbForTest({
    listLeadsEnabledBusinesses: async () => [
      { business_id: 'biz-a', name: 'A' },
      { business_id: 'biz-b', name: 'B' },
    ],
  });
  ds._setPreviewForTest(async (businessId) => {
    if (businessId === 'biz-a') throw new Error('boom');
    return { date: TODAY, mode: 'live', leads: [{ id: 'l-1', phone: '972501234567', trial_time: '09:00' }] };
  });
  const tg = armTelegram();
  await assert.doesNotReject(ds._tickForTest(IN_WINDOW_SUMMER));
  assert.equal(tg.length, 1); // biz-b still notified despite biz-a's failure
});

test('fail-soft: a broken business-list query is logged and swallowed, never thrown', async () => {
  ds._setDbForTest({ listLeadsEnabledBusinesses: async () => { throw new Error('supabase down'); } });
  await assert.doesNotReject(ds._tickForTest(IN_WINDOW_SUMMER));
});

test('Telegram not configured: logs and skips rather than throwing', async () => {
  ds._setDbForTest({ listLeadsEnabledBusinesses: async () => [{ business_id: BIZ, name: 'B' }] });
  ds._setPreviewForTest(async () => ({ date: TODAY, mode: 'live', leads: [{ id: 'l-1', phone: '972501234567', trial_time: '10:00' }] }));
  // no TELEGRAM_BOT_TOKEN/CHAT_ID set, no fetch seam armed
  await assert.doesNotReject(ds._tickForTest(IN_WINDOW_SUMMER));
});

test('the studio link honors STUDIO_BASE_URL when set', async () => {
  process.env.STUDIO_BASE_URL = 'https://staging.example.com/';
  ds._setDbForTest({ listLeadsEnabledBusinesses: async () => [{ business_id: BIZ, name: 'B' }] });
  ds._setPreviewForTest(async () => ({ date: TODAY, mode: 'live', leads: [{ id: 'l-1', phone: '972501234567', trial_time: '10:00' }] }));
  const tg = armTelegram();
  await ds._tickForTest(IN_WINDOW_SUMMER);
  assert.ok(tg[0].text.includes('https://staging.example.com/demo.html?biz='));
});

test('startDailyScheduler is idempotent and stoppable', () => {
  ds._setDbForTest({ listLeadsEnabledBusinesses: async () => [] });
  const t1 = ds.startDailyScheduler();
  const t2 = ds.startDailyScheduler();
  assert.equal(t1, t2);
  ds.stopDailyScheduler();
});

test('index.js registers the scheduler with a lazy, fail-soft one-liner', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(src.includes("import('./lib/daily-scheduler.js')"));
  assert.ok(src.includes('startDailyScheduler'));
  assert.ok(src.includes('.catch('), 'a broken module must not fail boot');
});
