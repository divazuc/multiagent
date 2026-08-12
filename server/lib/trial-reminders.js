// The 09:00 trial-day reminder run (POST /cron/trial-reminders).
//
// Every morning an external cron (same cron-job.org convention the follow-up
// processor was built for) hits the secured endpoint. For each business with
// the `leads` module enabled:
//   1. sync the registration sheet first, if one is configured
//      (lib/leads-sheet.js — fail SOFT here: a broken sheet must not cost the
//      already-synced leads their reminder);
//   2. find leads whose payload.trial_date is TODAY in Asia/Jerusalem and who
//      were not already reminded today (payload.reminder_sent_on);
//   3. send the WhatsApp reminder FROM THE BUSINESS'S OWN NUMBER
//      (lib/wa-send.js resolves per-business credentials). If the free-form
//      send fails (lead outside the 24h service window), fall back to the
//      approved utility template — same env-gated pattern as the relay's
//      WHATSAPP_ESCALATION_TEMPLATE (see scripts/create-trial-reminder-template.mjs);
//   4. record the outcome on the lead payload either way:
//      reminder_sent_on = today, reminder_status = sent|template_sent|window_failed
//      — that field is ALSO the dedupe key, so a second cron hit the same day
//      sends nothing.
//
// SAFETY (three states, owner's hard rule):
//   1. DRY-RUN (default; reminders_enabled != true) — logged "would send"
//      lines only. No WhatsApp send, no payload write.
//   2. TEST-REDIRECT (enabled + reminder_test_recipient set) — every send is
//      redirected to the test number, prefixed "[בדיקה — היה נשלח אל …]";
//      no real lead can receive anything, and the board is left untouched so
//      going live later still reminds everyone.
//   3. LIVE (enabled + no test recipient) — real sends to real leads.
//
// After the run the OWNER gets one Telegram summary (the existing
// lib/approvals.js plumbing — TELEGRAM_* env already on Railway), skipped
// entirely when no lead had a trial today.

import { telegramConfigured, sendTelegramText } from './approvals.js';

// ── Cron auth (constant-time, mirrors the booster's lib/express/auth.ts) ─────

export function cronAuthOk(authorizationHeader, secret) {
  if (!secret) return false; // unset CRON_SECRET = endpoint sealed, never open
  const h = String(authorizationHeader ?? '');
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (token.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= token.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

// ── Jerusalem calendar day ───────────────────────────────────────────────────
// Same convention as lib/studio.js#localDateKey — the trial DATE is a wall
// date in Israel, never a UTC one.

export function jerusalemDateKey(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }); // YYYY-MM-DD
}

const displayDate = (dateKey) => {
  const [y, m, d] = String(dateKey).split('-');
  return `${d}.${m}.${y}`;
};

// ── Reminder copy ────────────────────────────────────────────────────────────
// Default: conditional child-name and time segments. Per-business override via
// module settings `reminder_copy`, which may carry the placeholders {שם}
// (child name, empty when unknown) and {שעה} (trial time, empty when unknown).

export function buildReminderText({ child_name = null, trial_time = null, copy = null } = {}) {
  if (copy) {
    // A missing value drops its WHOLE phrase, never just the token, so the
    // owner-approved copy stays grammatical: with no hour,
    // "…קידס 🐉 היום בשעה {שעה}. כתובתנו…" → "…קידס 🐉 היום. כתובתנו…"
    let text = copy;
    text = child_name
      ? text.replaceAll('{שם}', child_name)
      : text.replace(/ ?של \{שם\}/g, '').replaceAll('{שם}', '');
    text = trial_time
      ? text.replaceAll('{שעה}', trial_time)
      : text.replace(/ ?בשעה \{שעה\}/g, '').replaceAll('{שעה}', '');
    return text.replace(/[ ]{2,}/g, ' ').trim();
  }
  const who = child_name ? ` של ${child_name}` : '';
  const when = trial_time ? ` בשעה ${trial_time}` : '';
  return `בוקר טוב! מזכירות שהיום מתקיים אימון הניסיון${who}${when} — מחכים לכם! נתראה 🐉`;
}

// Template params can never be empty (Graph rejects the whole send). The
// trial_reminder_he body carries ONE variable — {{1}} = the hour — and reads
// naturally with this fallback: "…היום בשעה שנקבעה." (see
// scripts/create-trial-reminder-template.mjs for the full owner-approved body).
export const TEMPLATE_PARAM_FALLBACKS = { trial_time: 'שנקבעה' };

// '972520000000' → '0520000000' — how a number reads in owner-facing copy.
const localPhone = (p) => String(p ?? '').startsWith('972') ? '0' + String(p).slice(3) : String(p ?? '');

// ── Owner summary copy ───────────────────────────────────────────────────────

export function buildOwnerSummary({ dateKey, sent, windowFailed, wouldSend, testRecipient = null }) {
  const lines = [];
  if (sent + windowFailed > 0) {
    let line = `🐉 תזכורות אימון ניסיון (${displayDate(dateKey)}): נשלחו ${sent}.`;
    if (windowFailed > 0) line += ` ${windowFailed} לא נשלחו (מחוץ לחלון).`;
    if (testRecipient) line += ` (מצב בדיקה — הכל הופנה ל-${localPhone(testRecipient)})`;
    lines.push(line);
  }
  if (wouldSend > 0) {
    lines.push(`🐉 תזכורות אימון ניסיון (${displayDate(dateKey)}) — הרצת ניסיון: ${wouldSend} תזכורות היו נשלחות (המנגנון כבוי עד אישור).`);
  }
  return lines.length ? lines.join('\n') : null;
}

// ── Seams ────────────────────────────────────────────────────────────────────

let db = null; // test seam
export function _setDbForTest(fake) { db = fake; }

async function realDb() {
  const { supabase } = await import('./supabase.js');
  return {
    // Every leads-enabled business, settings included (sheet + reminder config).
    async listLeadsBusinesses() {
      const { data, error } = await supabase.from('business_modules')
        .select('business_id, settings').eq('module_key', 'leads').eq('enabled', true);
      if (error) throw error;
      return data ?? [];
    },
    async listLeads(businessId) {
      const { data, error } = await supabase.from('leads').select('*')
        .eq('business_id', businessId).limit(1000);
      if (error) throw error;
      return data ?? [];
    },
    async updateLead(id, patch) {
      const { error } = await supabase.from('leads')
        .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
      if (error) throw error;
    },
    // ONE business's leads-module row (enabled + settings) — the manual
    // preview/send below act on a single business, unlike the automatic
    // run's listLeadsBusinesses() sweep. Same query as lib/leads.js#getLeadsModule.
    async getLeadsModule(businessId) {
      const { data, error } = await supabase.from('business_modules')
        .select('enabled, settings').eq('business_id', businessId).eq('module_key', 'leads').maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
  };
}

const getDb = async () => db ?? await realDb();

// WhatsApp send seams — real path lazy-imports lib/wa-send.js so tests run
// without env, exactly like the relay's sender seam.
let sender = null;
export function _setSenderForTest(fn) { sender = fn; }
let templateSender = null;
export function _setTemplateSenderForTest(fn) { templateSender = fn; }

async function sendText(msg) {
  if (sender) return sender(msg);
  const { sendWhatsAppMessage } = await import('./wa-send.js');
  return sendWhatsAppMessage(msg);
}

async function sendTemplate(msg) {
  if (templateSender) return templateSender(msg);
  const { sendWhatsAppTemplate } = await import('./wa-send.js');
  return sendWhatsAppTemplate(msg);
}

// Sheet-sync seam — real path is lib/leads-sheet.js#syncSheetLeads.
let sheetSync = null;
export function _setSheetSyncForTest(fn) { sheetSync = fn; }

async function syncSheet(businessId, now) {
  if (sheetSync) return sheetSync(businessId, { now });
  const { syncSheetLeads } = await import('./leads-sheet.js');
  return syncSheetLeads(businessId, { now });
}

// ── The run ──────────────────────────────────────────────────────────────────

// A send "landed" only when Graph returned a message id — an error body or a
// network null is a failure, same success criterion as the relay.
const delivered = (res) => !!res?.messages?.[0]?.id;

const httpError = (message, status) => { const e = new Error(message); e.status = status; return e; };

// Free-form first, approved template on a re-engagement-window failure —
// the exact fallback ladder + test-redirect prefixing described at the top
// of this file. Shared by the automatic run below AND the studio's manual
// preview/send (owner's spec: "the EXISTING send path... exactly as-is") so
// there is exactly one place this logic can drift. Returns the final status
// only — callers own their own counters/records, which differ between the
// two paths (aggregate totals vs. per-lead results with a timestamp).
async function attemptReminderSend({ businessId, phone, text, testRecipient, templateName, trialTime }) {
  const to = testRecipient ?? phone;
  const outText = testRecipient
    ? `[בדיקה — היה נשלח אל ${localPhone(phone)}]\n${text}`
    : text;
  const res = await sendText({ to, text: outText, businessId });
  if (delivered(res)) return { to, status: 'sent' };
  if (templateName) {
    const tres = await sendTemplate({
      to, templateName, langCode: 'he',
      bodyParams: [trialTime || TEMPLATE_PARAM_FALLBACKS.trial_time],
      businessId,
    });
    if (delivered(tres)) return { to, status: 'template_sent' };
  }
  return { to, status: 'window_failed' };
}

export async function runTrialReminders({ now = new Date() } = {}) {
  const d = await getDb();
  const today = jerusalemDateKey(now);
  const totals = { sent: 0, templateSent: 0, windowFailed: 0, wouldSend: 0 };
  const perBusiness = [];
  let anyTestRecipient = null; // set while any business runs in test-redirect

  const businesses = await d.listLeadsBusinesses();
  for (const biz of businesses) {
    const businessId = biz.business_id;
    const settings = biz.settings ?? {};
    const result = { business_id: businessId, synced: null, reminders: [] };

    // 1. Sheet first — today's form signups must make today's reminder pass.
    if (settings.sheet_file_id) {
      try {
        result.synced = await syncSheet(businessId, now);
      } catch (e) {
        console.error(`[trial-reminders] sheet sync failed for ${businessId} (reminders continue):`, e.message);
        result.synced = { synced: false, error: e.message };
      }
    }

    // 2. Today's trials, not yet reminded today. not_relevant is a human
    //    "leave them alone" mark — automation never messages past it.
    let leads = [];
    try {
      leads = await d.listLeads(businessId);
    } catch (e) {
      console.error(`[trial-reminders] could not list leads for ${businessId}:`, e.message);
      perBusiness.push(result);
      continue;
    }
    const due = leads.filter(l =>
      l.payload?.trial_date === today &&
      l.payload?.reminder_sent_on !== today &&
      l.status !== 'not_relevant');

    // THREE STATES (owner's hard safety rule — no real lead may be messaged
    // during testing):
    //   dry-run       reminders_enabled != true       nothing sent at all
    //   test-redirect enabled + reminder_test_recipient EVERY send goes to the
    //                                                  test number, prefixed
    //                                                  with the real target
    //   live          enabled + NO test recipient      real sends to leads
    const dryRun = settings.reminders_enabled !== true;
    const testRecipient = String(settings.reminder_test_recipient ?? '').trim() || null;
    const mode = dryRun ? 'dry_run' : (testRecipient ? 'test_redirect' : 'live');
    result.mode = mode;
    if (mode === 'test_redirect') anyTestRecipient = testRecipient;
    const templateName = (settings.reminder_template ?? process.env.WHATSAPP_TRIAL_REMINDER_TEMPLATE)?.trim() || null;

    for (const lead of due) {
      const text = buildReminderText({
        child_name: lead.payload?.child_name ?? null,
        trial_time: lead.payload?.trial_time ?? null,
        copy: settings.reminder_copy ?? null,
      });

      if (dryRun) {
        // 3-dry. Log-only until the owner approves the copy — no send, and no
        // payload write, so flipping the switch later still reminds everyone.
        console.log(`[trial-reminders] DRY RUN (${businessId}) would send to ${lead.phone}: ${text}`);
        totals.wouldSend++;
        result.reminders.push({ phone: lead.phone, status: 'dry_run' });
        continue;
      }

      // 3. Free-form first (leads usually wrote to the bot recently), then
      //    the approved utility template for out-of-window leads ({{1}} =
      //    the hour). In test-redirect the LEAD'S number never reaches a
      //    send seam — the one destination is the test recipient, and the
      //    prefix line names who the message was really for.
      const { status } = await attemptReminderSend({
        businessId, phone: lead.phone, text, testRecipient, templateName,
        trialTime: lead.payload?.trial_time,
      });
      if (status === 'sent') totals.sent++;
      else if (status === 'template_sent') totals.templateSent++;
      else totals.windowFailed++;

      // 4. Record either way — reminder_sent_on doubles as the dedupe key.
      //    NOT in test-redirect: a rehearsal must leave the board untouched,
      //    so going live later still reminds everyone (and repeat test runs
      //    keep producing the full picture).
      if (!testRecipient) {
        try {
          await d.updateLead(lead.id, {
            payload: { ...(lead.payload ?? {}), reminder_sent_on: today, reminder_status: status },
          });
        } catch (e) {
          console.error(`[trial-reminders] could not record reminder outcome for lead ${lead.id}:`, e.message);
        }
      }
      result.reminders.push(testRecipient
        ? { phone: lead.phone, status, redirected_to: testRecipient }
        : { phone: lead.phone, status });
    }
    perBusiness.push(result);
  }

  // Owner summary — sent + template_sent both count as "נשלחו". Skipped when
  // NO lead had a trial today (nothing to report, no noise).
  const summary = buildOwnerSummary({
    dateKey: today,
    sent: totals.sent + totals.templateSent,
    windowFailed: totals.windowFailed,
    wouldSend: totals.wouldSend,
    testRecipient: anyTestRecipient,
  });
  let summarySent = false;
  if (summary && telegramConfigured()) {
    try { summarySent = await sendTelegramText(summary); }
    catch (e) { console.error('[trial-reminders] owner summary failed:', e.message); }
  }

  return { date: today, ...totals, businesses: perBusiness, summary, summarySent };
}

// ── Manual preview/send (owner-in-the-loop, studio leads-board screen) ──────
// Replaces the old fully-automatic 09:00 WhatsApp send for day-to-day use:
// lib/daily-scheduler.js tells the owner (via Telegram) that today has trial
// signups; she opens the studio, picks the date (default today), sees this
// preview, unchecks anyone who said they won't come, and hits "שלח תזכורת" —
// which calls sendTrialReminders with exactly the ids she left checked.
//
// Both reuse attemptReminderSend/buildReminderText above, so the send itself
// (free-form → template fallback, the three safety modes, the test-redirect
// prefix) is byte-for-byte the same mechanism the automatic run used.

/**
 * Every lead whose payload.trial_date matches dateKey (default: today,
 * Israel wall date), for ONE business. `already_sent`/`reminder_status`/
 * `reminder_sent_at` are scoped to THIS date — a lead reminded for an
 * earlier trial date reads as not-yet-reminded for a later one, exactly
 * like the automatic run's per-day dedupe. Also returns the business's
 * current safety mode so the studio can show a "test mode" banner before
 * the owner presses send.
 */
export async function previewTrialReminders(businessId, dateKey = null) {
  if (!businessId) throw httpError('business is required', 400);
  const d = await getDb();
  const today = dateKey || jerusalemDateKey();

  const mod = await d.getLeadsModule(businessId);
  if (!mod?.enabled) throw httpError('leads module is not enabled', 400);
  const settings = mod.settings ?? {};
  const dryRun = settings.reminders_enabled !== true;
  const testRecipient = String(settings.reminder_test_recipient ?? '').trim() || null;
  const mode = dryRun ? 'dry_run' : (testRecipient ? 'test_redirect' : 'live');

  let leads = [];
  try { leads = await d.listLeads(businessId); }
  catch (e) { console.error(`[trial-reminders] preview: could not list leads for ${businessId}:`, e.message); }

  const due = leads.filter(l => l.payload?.trial_date === today && l.status !== 'not_relevant');
  const rows = due.map(l => {
    const sentForThisDate = l.payload?.reminder_sent_on === today;
    return {
      id: l.id,
      phone: l.phone,
      display_name: l.display_name ?? l.payload?.parent_name ?? null,
      child_name: l.payload?.child_name ?? null,
      trial_time: l.payload?.trial_time ?? null,
      status: l.status,
      already_sent: sentForThisDate,
      reminder_status: sentForThisDate ? (l.payload?.reminder_status ?? null) : null,
      reminder_sent_at: sentForThisDate ? (l.payload?.reminder_sent_at ?? null) : null,
    };
  });
  rows.sort((a, b) => (a.trial_time ?? '').localeCompare(b.trial_time ?? ''));

  return { date: today, mode, test_recipient: testRecipient, leads: rows };
}

/**
 * Send the reminder to exactly the checked leads (leadIds) for one date, on
 * one business. Business AND date scoped twice over as defense in depth:
 * `d.listLeads(businessId)` can only ever return this tenant's rows, and a
 * checked id is also required to still show today's trial_date and not be
 * marked 'not_relevant' — so a stale id from an already-closed screen can
 * never message the wrong lead. Already-sent-for-this-date leads are NOT
 * filtered out here (unlike the automatic run) — the owner re-checking one
 * on purpose is exactly how a deliberate resend happens.
 */
export async function sendTrialReminders(businessId, { dateKey = null, leadIds = [] } = {}) {
  if (!businessId) throw httpError('business is required', 400);
  const ids = (Array.isArray(leadIds) ? leadIds : []).map(String);
  if (!ids.length) throw httpError('lead_ids is required', 400);

  const d = await getDb();
  const today = dateKey || jerusalemDateKey();

  const mod = await d.getLeadsModule(businessId);
  if (!mod?.enabled) throw httpError('leads module is not enabled', 400);
  const settings = mod.settings ?? {};
  const dryRun = settings.reminders_enabled !== true;
  const testRecipient = String(settings.reminder_test_recipient ?? '').trim() || null;
  const mode = dryRun ? 'dry_run' : (testRecipient ? 'test_redirect' : 'live');
  const templateName = (settings.reminder_template ?? process.env.WHATSAPP_TRIAL_REMINDER_TEMPLATE)?.trim() || null;

  const allLeads = await d.listLeads(businessId);
  const idSet = new Set(ids);
  const targets = allLeads.filter(l =>
    idSet.has(String(l.id)) && l.payload?.trial_date === today && l.status !== 'not_relevant');

  const results = [];
  for (const lead of targets) {
    const text = buildReminderText({
      child_name: lead.payload?.child_name ?? null,
      trial_time: lead.payload?.trial_time ?? null,
      copy: settings.reminder_copy ?? null,
    });

    if (dryRun) {
      console.log(`[trial-reminders] manual DRY RUN (${businessId}) would send to ${lead.phone}: ${text}`);
      results.push({ id: lead.id, phone: lead.phone, status: 'dry_run' });
      continue;
    }

    const { status } = await attemptReminderSend({
      businessId, phone: lead.phone, text, testRecipient, templateName,
      trialTime: lead.payload?.trial_time,
    });

    // Same hard rule as the automatic run: a test-redirect rehearsal leaves
    // the board untouched, so going live later still reminds everyone.
    if (!testRecipient) {
      try {
        await d.updateLead(lead.id, {
          payload: {
            ...(lead.payload ?? {}),
            reminder_sent_on: today, reminder_status: status,
            reminder_sent_at: new Date().toISOString(), // studio badge needs a real timestamp, not just the date
          },
        });
      } catch (e) {
        console.error(`[trial-reminders] manual send: could not record outcome for lead ${lead.id}:`, e.message);
      }
    }
    results.push(testRecipient
      ? { id: lead.id, phone: lead.phone, status, redirected_to: testRecipient }
      : { id: lead.id, phone: lead.phone, status });
  }

  return {
    date: today, mode, test_recipient: testRecipient,
    requested: ids.length, skipped: ids.length - targets.length, results,
    sent_count: results.filter(r => r.status === 'sent' || r.status === 'template_sent').length,
  };
}

// ── Cron auto-send guard (owner's spec: manual mode is now the default) ─────
// The 09:00 external cron hit (if one is still configured) used to always
// run the fully-automatic WhatsApp-sending pass. That is now OFF by default —
// lib/daily-scheduler.js's Telegram notice + the studio's manual send screen
// are the default flow. Flip TRIAL_REMINDERS_CRON_AUTOSEND=true on Railway to
// restore the old always-auto-send behavior; the endpoint's `force` override
// (index.js) exists so the cron endpoint still works as a manual/fallback
// trigger regardless of the flag.
export function cronAutoSendEnabled(env = process.env) {
  return env.TRIAL_REMINDERS_CRON_AUTOSEND === 'true';
}
