// One-tap PROCESS approval — the page behind the Telegram link for
// owner_approval_request events (payment_verify / work_confirm).
//
// Public like /meeting: the token IS the credential (32 random bytes, stored
// only as a SHA-256 hash — lib/process-approval.js). GET is side-effect-free
// because Telegram prefetches every link it shows; the approval itself is the
// page's POST button, which calls the booster's execute endpoint and consumes
// the token ONLY on booster success — a failed execute leaves the token
// usable so a retry is one more tap, never a dead link.
import { Router } from 'express';
import { page, sendPage as send, escapeHtml as esc } from '../lib/approvals.js';
import { findProcessApprovalByToken, consumeProcessApproval, approvalExpired } from '../lib/process-approval.js';
import { executeApproval, boosterLeadPanelUrl } from '../lib/booster-client.js';

const router = Router();

// Booster-execute seam — same convention as _setSendForTest in
// routes/booster-webhook.js; production always calls the real client.
let executeFn = executeApproval;
export const _setExecuteApprovalForTest = (fn) => { executeFn = fn ?? executeApproval; };

const KIND_COPY = {
  payment_verify: { title: '💰 אסמכתת תשלום ממתינה לאישור', button: 'אישור תשלום ✓' },
  work_confirm: { title: '📄 הלקוח סיים לערוך תכנים — לאשר התחלת עבודה?', button: 'אישור התחלת עבודה ✓' },
};

const NOT_VALID = () => page('הקישור לא בתוקף', '<p>הקישור שגוי או שפג תוקפו.</p>', 404);
const ALREADY = () => page('כבר טופל', '<p>הבקשה הזאת כבר טופלה.</p>');
const OOPS = () => page('משהו השתבש', '<p>נסו שוב עוד רגע.</p>', 500);

// One validation for both routes. States:
//   missing  — no such token (or garbage)   → 404-style page
//   consumed — approved already             → "כבר טופל"
//   expired  — pending but older than 7 days → 404-style page
// A record whose kind this deploy doesn't render is treated as missing.
async function loadApproval(token) {
  const row = await findProcessApprovalByToken(token);
  if (!row) return { state: 'missing' };
  if (row.detail?.status !== 'pending') return { state: 'consumed', row };
  if (approvalExpired(row)) return { state: 'expired', row };
  if (!KIND_COPY[row.detail?.kind]) return { state: 'missing', row };
  return { state: 'ok', row };
}

const panelLink = (leadId) =>
  `<p><a href="${esc(boosterLeadPanelUrl(leadId))}">מעבר לפאנל</a></p>`;

router.get('/approve/:token', async (req, res) => {
  try {
    const { state, row } = await loadApproval(req.params.token);
    if (state === 'consumed') return send(res, ALREADY());
    if (state !== 'ok') return send(res, NOT_VALID());
    const d = row.detail;
    const copy = KIND_COPY[d.kind];
    const details = [
      `<p><b>לקוח:</b> ${esc(d.client_name)}</p>`,
      `<p><b>הזמנה:</b> ${esc(d.quote_number)}</p>`,
      d.phone ? `<p><b>טלפון:</b> ${esc(d.phone)}</p>` : '',
      d.kind === 'payment_verify' && d.amount !== null && d.amount !== undefined && d.amount !== ''
        ? `<p><b>סכום:</b> ₪${esc(d.amount)}</p>` : '',
      d.context ? `<p>${esc(d.context)}</p>` : '',
      `<form method="post" action="/approve/${encodeURIComponent(req.params.token)}/confirm"><button class="ok" type="submit">${copy.button}</button></form>`,
      panelLink(d.lead_id),
    ].join('');
    return send(res, page(copy.title, details));
  } catch (e) {
    console.error('[process-approval] GET failed:', e.message);
    return send(res, OOPS());
  }
});

// The booster's error codes, translated for the page. Anything unmapped shows
// the code itself — an honest page beats a vague one when Diva then opens the
// panel to finish the job by hand.
function humanReason(code) {
  if (code === 'timeout') return 'הבוסטר לא הגיב בזמן. אפשר לנסות שוב.';
  if (code === 'network') return 'אין כרגע חיבור לבוסטר. אפשר לנסות שוב.';
  return `הבוסטר החזיר שגיאה (${code ?? 'unknown'}). אפשר לנסות שוב או לטפל מהפאנל.`;
}

router.post('/approve/:token/confirm', async (req, res) => {
  try {
    const { state, row } = await loadApproval(req.params.token);
    if (state === 'consumed') return send(res, ALREADY());
    if (state !== 'ok') return send(res, NOT_VALID());
    const d = row.detail;

    // The booster owns the actual transition. Never throws: {ok} | {ok,error}.
    const result = await executeFn({ kind: d.kind, leadId: d.lead_id });
    if (!result?.ok) {
      // NOT consumed — the same token retries with one more tap.
      console.error('[process-approval] execute failed:', d.kind, 'lead', d.lead_id, result?.error);
      const body = [
        `<p>הפעולה לא הושלמה: ${esc(humanReason(result?.error))}</p>`,
        `<form method="post" action="/approve/${encodeURIComponent(req.params.token)}/confirm"><button class="ok" type="submit">${KIND_COPY[d.kind].button}</button></form>`,
        panelLink(d.lead_id),
      ].join('');
      return send(res, page('הפעולה לא הושלמה', body, 502));
    }

    // Single-use: consumed only after the booster confirmed. A consume failure
    // must not resurface as an error page inviting a double-execute.
    await consumeProcessApproval(row, 'approved').catch(e =>
      console.error('[process-approval] consume failed after execute:', e.message));

    return send(res, page('אושר ✓', '<p>הפאנל עודכן.</p>'));
  } catch (e) {
    console.error('[process-approval] confirm failed:', e.message);
    return send(res, OOPS());
  }
});

export default router;
