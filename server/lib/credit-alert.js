// Cost-efficiency pass (2026-08-12), item 6: the night the owner asked for
// this pass, the Anthropic account had actually run OUT of credits and the
// bot was silently failing every reply with no signal to anyone. This module
// is the tripwire: when a model call fails with the credit-balance 400,
// fire the owner's existing Telegram approvals channel (lib/approvals.js —
// the same plumbing meeting/process approvals already use) so she finds out
// from a phone buzz, not from a customer complaint.
//
// Wired from agents/conversation.js's top-level catch — every model call in
// that file (intent, reply, rewrite) funnels through the same try/catch, so
// one hook here covers all of them.

import { sendTelegramText, telegramConfigured } from './approvals.js';

export const ALERT_TEXT =
  '⚠️ הבוט לא מצליח לענות — נגמרו הקרדיטים בחשבון ה-API. לטעינה: console.anthropic.com → Plans & Billing';

// Once per hour — a burst of failing messages must not spam the owner's
// Telegram once per customer message.
const COOLDOWN_MS = 60 * 60 * 1000;

// -Infinity, not 0: "never sent" must never collide with a small mocked
// clock value in tests (a real Date.now() is always >> COOLDOWN_MS past the
// Unix epoch, so this only matters under a mocked clock — but it did bite:
// `now() - 0 < COOLDOWN_MS` was true, and wrongly suppressed, for any
// mocked "now" under one hour since epoch).
let lastSentAt = -Infinity;

// Test seam for the clock — the cooldown is otherwise untestable without a
// real hour of wall-clock waiting.
let _now = null;
export function _setNowForTest(fn) { _now = fn; }
export function _resetCreditAlertForTest() { lastSentAt = -Infinity; _now = null; }
function now() { return _now ? _now() : Date.now(); }

// The Anthropic SDK's credit-exhaustion error is a plain 400
// (invalid_request_error) whose message text names the cause — there is no
// dedicated error type to switch on, so matching the message is the
// documented way to distinguish it from any other bad-request 400.
export function isCreditExhaustionError(err) {
  const status = err?.status ?? err?.statusCode ?? null;
  const message = String(err?.message ?? '');
  return status === 400 && /credit balance/i.test(message);
}

// Fire-and-forget by design (callers should not await-and-throw on this) but
// returns a promise so tests can await it. Fails soft in every direction: a
// non-matching error is a silent no-op, a still-cooling-down alert is a
// silent no-op, no Telegram env is a log line instead of a crash, and a
// failed send is caught and logged, never re-thrown.
export async function alertCreditExhaustion(err) {
  if (!isCreditExhaustionError(err)) return false;

  const t = now();
  if (t - lastSentAt < COOLDOWN_MS) return false;
  lastSentAt = t;

  if (!telegramConfigured()) {
    console.warn('[credit-alert] Anthropic credits exhausted but Telegram is not configured — logging only:', ALERT_TEXT);
    return false;
  }

  try {
    return await sendTelegramText(ALERT_TEXT);
  } catch (e) {
    console.error('[credit-alert] Telegram send failed:', e.message);
    return false;
  }
}
