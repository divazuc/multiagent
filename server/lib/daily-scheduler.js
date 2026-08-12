// Owner-in-the-loop trial-day notice — the replacement for the old
// fully-automatic 09:00 WhatsApp send (see lib/trial-reminders.js's header
// for that story). In-process scheduler, registered from index.js with ONE
// line at boot (startDailyScheduler()) — no external cron.
//
// Every day, once, at local 09:00 Asia/Jerusalem: for every leads-enabled
// business, ask lib/trial-reminders.js#previewTrialReminders for TODAY's
// trial signups — the exact same list the studio's manual-send screen shows.
// Any business with at least one signup gets ONE Telegram message: how many,
// who + what time, and a link straight to that business's studio leads
// screen. No WhatsApp send happens here, ever — the owner reviews and sends
// herself.
//
// Timezone: Intl (toLocaleString with timeZone: 'Asia/Jerusalem') — NEVER a
// hardcoded UTC offset, so the fire hour stays correct straight through the
// spring/autumn DST switch (Israel does not follow the US switch dates).
//
// Fire-once-per-day + restart tolerance: tracks the last LOCAL DATE (YYYY-MM-DD,
// Jerusalem) it already ran. A 1-minute poll checks "is it inside the 09:00
// local hour AND have I not fired today yet" — true on the FIRST tick after
// boot if that boot happens to land inside the window (a Railway
// restart/deploy during 09:00–09:59), true on every following minute of that
// same hour is a no-op because today is already marked fired. The date is
// claimed BEFORE the async run, not after, so a slow/failed run can never
// cause a second attempt later the same hour — at most one notice per
// business per day, matching the automatic run's own per-day dedupe.
//
// Fail-soft: the whole tick is one try/catch, and each business inside it is
// its own try/catch — a Supabase hiccup or a Telegram timeout is logged and
// swallowed, never crashes the process or cancels the other businesses.

import { telegramConfigured, sendTelegramText } from './approvals.js';
import { jerusalemDateKey } from './trial-reminders.js';

const POLL_MS = 60 * 1000; // 1 minute — cheap, plenty precise for a once-a-day fire
const FIRE_HOUR = 9; // local hour (09:00–09:59 Asia/Jerusalem) — same convention as the old cron

function jerusalemHour(now = new Date()) {
  return Number(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }));
}

// '2026-08-14' → '14.08.2026' — same display convention as
// lib/trial-reminders.js's owner summary copy.
const displayDate = (dateKey) => {
  const [y, m, d] = String(dateKey).split('-');
  return `${d}.${m}.${y}`;
};

// ── State ─────────────────────────────────────────────────────────────────
let lastFiredDate = null; // YYYY-MM-DD Jerusalem — the fire-once-per-day gate
let timer = null;

export function _resetForTest() { lastFiredDate = null; }
export function _setLastFiredForTest(dateKey) { lastFiredDate = dateKey; }

// ── DB seam ───────────────────────────────────────────────────────────────
let db = null; // test seam
export function _setDbForTest(fake) { db = fake; }

async function realDb() {
  const { supabase } = await import('./supabase.js');
  return {
    // Every business with the leads module enabled, with its name (for the
    // Telegram copy). Two plain queries rather than an embedded FK select —
    // consistent with the rest of this codebase's db seams.
    async listLeadsEnabledBusinesses() {
      const { data, error } = await supabase.from('business_modules')
        .select('business_id').eq('module_key', 'leads').eq('enabled', true);
      if (error) throw error;
      const ids = (data ?? []).map(r => r.business_id);
      if (!ids.length) return [];
      const { data: rows, error: bizErr } = await supabase.from('businesses')
        .select('id, name').in('id', ids);
      if (bizErr) throw bizErr;
      const nameOf = Object.fromEntries((rows ?? []).map(b => [b.id, b.name]));
      return ids.map(business_id => ({ business_id, name: nameOf[business_id] ?? null }));
    },
  };
}
const getDb = async () => db ?? await realDb();

// Preview seam — real path is lib/trial-reminders.js#previewTrialReminders,
// the SAME list the studio's manual send screen shows (single source of
// truth for "does this business have a trial today").
let previewFn = null;
export function _setPreviewForTest(fn) { previewFn = fn; }
async function preview(businessId, dateKey) {
  if (previewFn) return previewFn(businessId, dateKey);
  const { previewTrialReminders } = await import('./trial-reminders.js');
  return previewTrialReminders(businessId, dateKey);
}

// ── Studio link + Telegram copy ──────────────────────────────────────────

function studioLink(businessId) {
  const base = (process.env.STUDIO_BASE_URL ?? 'https://multiagent.pages.dev').replace(/\/$/, '');
  return `${base}/demo.html?biz=${businessId}&view=leads&remind=1`;
}

function leadLine(l) {
  const who = l.child_name || l.display_name || l.phone;
  return l.trial_time ? `• ${who} — ${l.trial_time}` : `• ${who}`;
}

export function buildDailyNotice({ businessName, dateKey, leads, link }) {
  const header = `🐉 ${leads.length} נרשמו לניסיון היום אצל ${businessName ?? 'העסק'} (${displayDate(dateKey)}):`;
  return [header, ...leads.map(leadLine), '', `לשליחת התזכורות: ${link}`].join('\n');
}

// ── The daily check (exported directly — also the manual-invoke seam) ───────

/**
 * Runs the check for every leads-enabled business right now, regardless of
 * the fire-once gate — the gate lives in tick()/startDailyScheduler(), not
 * here, so this stays independently callable (tests, a future manual
 * "check now" op) without fighting the scheduler's own state.
 */
export async function runDailyCheck(now = new Date()) {
  const today = jerusalemDateKey(now);
  const notified = [];
  let businesses = [];
  try {
    businesses = await (await getDb()).listLeadsEnabledBusinesses();
  } catch (e) {
    console.error('[daily-scheduler] could not list leads-enabled businesses:', e.message);
    return { date: today, notified };
  }

  for (const biz of businesses) {
    try {
      const out = await preview(biz.business_id, today);
      if (!out?.leads?.length) continue;
      if (!telegramConfigured()) {
        console.warn(`[daily-scheduler] ${out.leads.length} trial signup(s) today for ${biz.business_id} but Telegram is not configured — no notice sent`);
        continue;
      }
      const text = buildDailyNotice({
        businessName: biz.name, dateKey: today, leads: out.leads, link: studioLink(biz.business_id),
      });
      const sent = await sendTelegramText(text);
      notified.push({ business_id: biz.business_id, count: out.leads.length, sent });
    } catch (e) {
      console.error(`[daily-scheduler] check failed for business ${biz.business_id} (other businesses unaffected):`, e.message);
    }
  }
  return { date: today, notified };
}

// ── The poll tick + public start/stop ────────────────────────────────────

async function tick(now = new Date()) {
  try {
    if (jerusalemHour(now) !== FIRE_HOUR) return;
    const today = jerusalemDateKey(now);
    if (lastFiredDate === today) return; // already ran today
    lastFiredDate = today; // claim the day BEFORE the async work — at most one attempt/day
    await runDailyCheck(now);
  } catch (e) {
    console.error('[daily-scheduler] tick failed (server keeps running):', e.message);
  }
}

// Test-only direct entry point to the gated tick (bypasses the interval).
export async function _tickForTest(now = new Date()) { return tick(now); }

export function startDailyScheduler() {
  if (timer) return timer; // idempotent — index.js registers this once; never arm a second timer
  tick(); // boot-recovery: fires immediately if we start inside 09:00–09:59 and haven't run today
  timer = setInterval(tick, POLL_MS);
  timer.unref?.(); // the scheduler alone must never keep the process (or a test run) alive
  return timer;
}

export function stopDailyScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
