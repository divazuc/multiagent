// Shared foundation for the owner's one-tap Telegram approvals — the pieces
// that are identical between a MEETING approval (lib/meeting-approval.js) and
// a PROCESS approval (lib/process-approval.js): token mint/hash, the public
// base URL, the Telegram send plumbing, and the RTL page shell the public
// routes render. Extracted from meeting-approval when process approvals
// arrived, byte-for-byte — the meeting tests pin the behavior.
import crypto from 'node:crypto';

// The token is stored ONLY as a SHA-256 hash — the raw token exists nowhere
// but inside the Telegram message, exactly like the booster's /q tokens.
export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
export const mintToken = () => crypto.randomBytes(32).toString('base64url');

// base64url of 32 bytes is 43 chars — anything wildly off never hits the db.
export const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;

// Same convention as google.js / studio.js — the Railway domain is the
// fallback when PUBLIC_BASE_URL is unset.
export function publicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL ?? 'https://wagent.divdev.co').replace(/\/$/, '');
}

// ── Telegram ─────────────────────────────────────────────────────────────────

export function telegramConfigured(env = process.env) {
  return !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
}

// A hung Telegram API must not hold the calling request hostage.
export const TELEGRAM_TIMEOUT_MS = 3500;

// Telegram HTTP seam — tests record the request instead of hitting the API.
// One seam for both approval flavors: they share this exact plumbing.
let telegramFetch = null;
export function _setTelegramFetchForTest(fn) { telegramFetch = fn; }

export async function sendTelegramText(text) {
  const doFetch = telegramFetch ?? fetch;
  const res = await doFetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text }),
    signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
  });
  return !!res?.ok;
}

// ── The RTL page shell the approval routes render ────────────────────────────

export const page = (title, body, status = 200) => [status,
  `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f4f6fb}main{background:#fff;padding:32px 40px;border-radius:12px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:420px}h2{margin-top:0}p{color:#333}form{display:inline-block;margin:8px}button{font-size:17px;padding:12px 28px;border:0;border-radius:10px;cursor:pointer}.ok{background:#1a9c4b;color:#fff}.alt{background:#e8eaf1;color:#222}</style></head><body><main><h2>${title}</h2>${body}</main></body></html>`];

export const sendPage = (res, [status, html]) => res.status(status).type('html').send(html);

export const escapeHtml = (s) => String(s ?? '—').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
