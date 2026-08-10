// One-tap meeting approval — the pages behind the Telegram links.
//
// Public like /oauth and /c: the token IS the credential (32 random bytes,
// stored only as a SHA-256 hash — lib/meeting-approval.js). GET is
// side-effect-free because Telegram prefetches every link it shows; the two
// actions are POSTs from the page's own forms. Either action consumes the
// token, and a token whose slot has already started is dead.
import { Router } from 'express';
import { findApprovalByToken, consumeApproval, slotParts } from '../lib/meeting-approval.js';
import { recordMeetingBooked, recordMeetingRequestCancelled, formatSlotOffer } from '../lib/booster-meeting.js';
import { getEnabledModules } from '../lib/modules/engine.js';
import calendarModule, { providerForSettings, TENTATIVE_TITLE_PREFIX } from '../lib/modules/calendar/index.js';
import { decryptSecrets } from '../lib/modules/crypto.js';
import { ilWallToUtc } from '../lib/modules/calendar/slots.js';
import { sendWhatsAppMessage } from '../lib/wa-send.js';
import { toWaNumber } from '../lib/booster-messages.js';

const router = Router();

// Test seam — same convention as routes/booster-webhook.js.
let sendFn = sendWhatsAppMessage;
export const _setSendForTest = (fn) => { sendFn = fn ?? sendWhatsAppMessage; };

const page = (title, body, status = 200) => [status,
  `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f4f6fb}main{background:#fff;padding:32px 40px;border-radius:12px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:420px}h2{margin-top:0}p{color:#333}form{display:inline-block;margin:8px}button{font-size:17px;padding:12px 28px;border:0;border-radius:10px;cursor:pointer}.ok{background:#1a9c4b;color:#fff}.alt{background:#e8eaf1;color:#222}</style></head><body><main><h2>${title}</h2>${body}</main></body></html>`];

const send = (res, [status, html]) => res.status(status).type('html').send(html);

const NOT_VALID = () => page('הקישור לא בתוקף', '<p>הקישור שגוי, פג תוקף או שהמועד כבר עבר.</p>', 404);
const ALREADY = () => page('כבר טופל', '<p>הבקשה הזאת כבר טופלה.</p>');
const OOPS = () => page('משהו השתבש', '<p>נסו שוב עוד רגע.</p>', 500);

// One validation for all three routes. States:
//   missing  — no such token (or garbage)         → 404-style page
//   consumed — approved/rescheduled already       → "כבר טופל"
//   expired  — still pending but the slot started → 404-style page
async function loadApproval(token) {
  const row = await findApprovalByToken(token);
  if (!row) return { state: 'missing' };
  if (row.detail?.status !== 'pending') return { state: 'consumed', row };
  const { date, from } = slotParts(row.detail.slot);
  if (!date || !from || ilWallToUtc(date, from).getTime() <= Date.now()) return { state: 'expired', row };
  return { state: 'ok', row };
}

// The event lives in the tenant's connected calendar — resolve the module row
// the same way the reply pipeline does, so secrets/settings are never
// duplicated onto the approval record.
async function calendarFor(businessId) {
  const rows = await getEnabledModules(businessId);
  const row = rows.find(r => r.module_key === 'calendar');
  if (!row) return null;
  const settings = calendarModule.settingsSchema.parse(row.settings ?? {});
  return { row, settings, provider: providerForSettings(settings), secrets: decryptSecrets(row.secrets) };
}

router.get('/meeting/:token', async (req, res) => {
  try {
    const { state, row } = await loadApproval(req.params.token);
    if (state === 'consumed') return send(res, ALREADY());
    if (state !== 'ok') return send(res, NOT_VALID());
    const d = row.detail;
    const { date, from, day } = slotParts(d.slot);
    const esc = (s) => String(s ?? '—').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    const details = [
      `<p><b>שם:</b> ${esc(d.name)}</p>`,
      `<p><b>טלפון:</b> ${esc(d.phone)}</p>`,
      `<p><b>מועד:</b> יום ${day} ${date} בשעה ${from}</p>`,
      d.quote_number ? `<p><b>הזמנה:</b> ${esc(d.quote_number)}</p>` : '',
      `<form method="post" action="/meeting/${encodeURIComponent(req.params.token)}/approve"><button class="ok" type="submit">אישור ✓</button></form>`,
      `<form method="post" action="/meeting/${encodeURIComponent(req.params.token)}/reschedule"><button class="alt" type="submit">שינוי מועד</button></form>`,
    ].join('');
    return send(res, page('בקשת פגישה', details));
  } catch (e) {
    console.error('[meeting-approval] GET failed:', e.message);
    return send(res, OOPS());
  }
});

router.post('/meeting/:token/approve', async (req, res) => {
  try {
    const { state, row } = await loadApproval(req.params.token);
    if (state === 'consumed') return send(res, ALREADY());
    if (state !== 'ok') return send(res, NOT_VALID());
    const d = row.detail;

    // (a) The calendar event becomes real: pending-marker off the title, and
    // the client added as an attendee when their address is known —
    // sendUpdates:'all' is what makes Google e-mail them the invite.
    // A patch failure aborts WITHOUT consuming, so the owner can just retry.
    const cal = await calendarFor(row.business_id);
    if (cal && d.event_id) {
      const ev = await cal.provider.getEvent(cal.secrets, d.event_id);
      const title = String(ev?.title ?? '');
      const patch = { title: title.startsWith(TENTATIVE_TITLE_PREFIX) ? title.slice(TENTATIVE_TITLE_PREFIX.length) : title };
      if (d.client_email) patch.attendees = [...(ev?.attendees ?? []), { email: d.client_email }];
      await cal.provider.patchEvent(cal.secrets, d.event_id, patch, { sendUpdates: 'all' });
    }

    // (b) The confirmed note — also what suppresses the booster's 3-day
    // reminder. Logs its own failures, never throws.
    await recordMeetingBooked({
      businessId: row.business_id, phone: d.phone, quoteNumber: d.quote_number, slot: d.slot,
    });

    // (c) Tell the client — the e-mail sentence only when an invite really
    // went out to an address.
    if (d.phone) {
      const { date, from, day } = slotParts(d.slot);
      const text = d.client_email
        ? `הפגישה אושרה! 🎉 יום ${day} ${date} בשעה ${from}. שלחתי לך זימון למייל 📧`
        : `הפגישה אושרה! 🎉 יום ${day} ${date} בשעה ${from}.`;
      await Promise.resolve(sendFn({ to: toWaNumber(d.phone), text, businessId: row.business_id })).catch(() => {});
    }

    // (d) Single-use: consumed only after the side effects landed. A failure
    // here must not resurface as an error page inviting a double-approve.
    await consumeApproval(row, 'approved').catch(e =>
      console.error('[meeting-approval] consume failed after approve:', e.message));

    return send(res, page('הפגישה אושרה ✓', '<p>הלקוח קיבל עדכון בוואטסאפ.</p>'));
  } catch (e) {
    console.error('[meeting-approval] approve failed:', e.message);
    return send(res, OOPS());
  }
});

router.post('/meeting/:token/reschedule', async (req, res) => {
  try {
    const { state, row } = await loadApproval(req.params.token);
    if (state === 'consumed') return send(res, ALREADY());
    if (state !== 'ok') return send(res, NOT_VALID());
    const d = row.detail;

    // (a) The tentative event is removed — the slot is free again. A delete
    // failure aborts WITHOUT consuming (retry-friendly, like approve).
    const cal = await calendarFor(row.business_id);
    if (cal && d.event_id) await cal.provider.deleteEvent(cal.secrets, d.event_id);

    // (b) Release the one-meeting hold: the client is about to be asked to
    // pick again, and the gate must let the new request through.
    await recordMeetingRequestCancelled({
      businessId: row.business_id, phone: d.phone, quoteNumber: d.quote_number, slot: d.slot,
    });

    // (c) Offer the CURRENT free slots so the re-pick runs the whole
    // request→Telegram loop again. No slots → the owner follows up manually.
    if (d.phone) {
      let offer = null;
      try {
        const slots = cal ? await calendarModule._computeCurrentSlots(cal.row) : [];
        offer = formatSlotOffer(slots, { quoteNumber: d.quote_number });
      } catch (e) {
        console.error('[meeting-approval] slot recompute failed — offering none:', e.message);
      }
      const owner = (cal?.settings.owner_display_name ?? '').trim();
      const text = offer
        ? `לגבי הפגישה — המועד הזה כבר לא מסתדר 🙏 הנה מועדים חלופיים:\n\n${offer}`
        : `לגבי הפגישה — המועד הזה כבר לא מסתדר 🙏 ${owner ? `${owner} תחזור אליך לתיאום מועד חדש.` : 'נחזור אליך לתיאום מועד חדש.'}`;
      await Promise.resolve(sendFn({ to: toWaNumber(d.phone), text, businessId: row.business_id })).catch(() => {});
    }

    // (d) Single-use — same discipline as approve.
    await consumeApproval(row, 'rescheduled').catch(e =>
      console.error('[meeting-approval] consume failed after reschedule:', e.message));

    return send(res, page('המועד שוחרר', '<p>הצעתי ללקוח מועדים חלופיים בוואטסאפ.</p>'));
  } catch (e) {
    console.error('[meeting-approval] reschedule failed:', e.message);
    return send(res, OOPS());
  }
});

export default router;
