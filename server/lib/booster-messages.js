// Hebrew WhatsApp copy per booster event. payload fields come from the
// booster's outbox (see divaz_booster lib/express/freeze.ts + leads.ts).
const nis = (n) => `₪${Math.round(Number(n) || 0).toLocaleString('he-IL')}`;

// v3 (meeting-before-payment): the bot now schedules the characterization
// meeting itself, in-conversation — `meeting_link` is only a fallback for
// channels without the bot (email / the quote screen). So when the payload
// carries no link, the copy invites the client to schedule right here in the
// chat instead of pointing at a URL. See docs/booster-meeting-scheduling-handoff.md.
const hasMeetingLink = (payload) =>
  typeof payload.meeting_link === 'string' && payload.meeting_link.trim() !== '';

const nextStepLine = (payload) =>
  hasMeetingLink(payload)
    ? `השלב הבא — פגישת אפיון קצרה איתי. אפשר לקבוע כאן: ${payload.meeting_link}`
    : `השלב הבא — פגישת אפיון קצרה איתי. בואו נתאם כאן בהודעות 🙂`;

export function boosterMessageFor(event, payload = {}, lead = {}) {
  const first = (lead.name ?? '').trim().split(/\s+/)[0] || '';
  switch (event) {
    case 'send_personal_link':
      return `היי ${first} 👋\nהכנתי לך קישור אישי לבניית הצעת המחיר שלך:\n${payload.link_url}\n\nהקישור אישי אלייך ותקף ל-${payload.valid_days ?? 14} ימים. אפשר לשחק עם התוספות ולראות מחיר מעודכן בכל שלב 🙂`;
    case 'send_signed_summary':
      return `תודה ${first}! ההצעה ${payload.quote_number} נחתמה 🎉\nסה"כ לתשלום: ${nis(payload.total)} (כולל מע"מ).\nעותק חתום נשלח אלייך במייל.\n\n${nextStepLine(payload)}`;
    case 'send_meeting_reminder': {
      const orderRef = payload.quote_number ? ` להזמנה ${payload.quote_number}` : '';
      return `תזכורת עדינה 🙂 עדיין לא קבענו את פגישת האפיון${orderRef}. ${nextStepLine(payload)}`;
    }
    case 'send_payment_details':
      return payload.payment_details
        ? `להשלמת התשלום עבור ${payload.quote_number}:\n${payload.payment_details}\n\nאחרי התשלום — שלחו לי כאן צילום מסך של האישור, ונאשר תוך יום עסקים 🙏`
        : `להשלמת התשלום עבור ${payload.quote_number} (${nis(payload.total)}) — פרטי התשלום מופיעים בעמוד ההצעה שלך. אחרי התשלום שלחו לי כאן צילום של האישור 🙏`;
    case 'send_payment_reminder':
      return `תזכורת קטנה 🙂 ההצעה ${payload.quote_number} (${nis(payload.total)}) ממתינה להשלמת תשלום. אם כבר שילמתם — שלחו לי צילום של האישור ואקדם את הפרויקט.`;
    case 'send_expiry_notice':
      // booster's app/api/express/expiry route enqueues this with reason
      // 'unsigned_14d' | 'unsigned_30d' | 'materials_30d' (see divaz_booster
      // lib/express/leads.ts + app/api/express/expiry/route.ts). materials_30d means
      // the client DID pay and send some materials, but the 30-day window to finish
      // closed — that is not "your link expired," it's "we closed the order and kept
      // your payment as a credit," so it needs its own text. Any other reason (both
      // unsigned_ variants, or a payload with no reason at all) is a plain link-expired
      // notice — matched with a catch-all `else` rather than an explicit list, so a new
      // graduated cutoff (e.g. a future unsigned_60d) never falls through unhandled.
      return payload.reason === 'materials_30d'
        ? `חלון 30 הימים להעברת החומרים חלף, ולכן ההזמנה נסגרה — התשלום ששולם נזקף כקרדיט לשנה מהיום 💳\nרוצים לחדש ולהמשיך? רק תכתבו לי כאן ונסדר את זה יחד 🙂`
        : `הקישור להצעת המחיר שלך פג תוקף ⏳ אם עדיין רלוונטי — כתבו לי כאן ונשמח לחדש אותו.`;
    // ── Materials stage (funnel track 1, T8) ─────────────────────────────────
    // Payload per the booster's meeting-before-payment plan Task 9:
    // { quote_number, folder_url, materials_doc_url, content_doc_url } — until
    // the booster ships that, events arrive with only { package_id }, so every
    // link line is optional and an empty/missing URL is skipped, never printed
    // blank. No prices, no payment talk: by this stage payment is behind us.
    case 'send_materials_checklist': {
      const links = [
        ['📁 תיקיית החומרים שלך', payload.folder_url],
        ['📋 מסמך הנחיות החומרים', payload.materials_doc_url],
        ['📝 מסמך התכנים למילוי', payload.content_doc_url],
      ].filter(([, url]) => typeof url === 'string' && url.trim() !== '');
      const orderRef = payload.quote_number ? ` להזמנה ${payload.quote_number}` : '';
      const linkBlock = links.length
        ? `\n${links.map(([label, url]) => `${label}: ${url}`).join('\n')}\n`
        : '\n';
      return `עוברים לשלב החומרים${orderRef} 🙌 הכנתי לך את כל מה שצריך כדי שנוכל להתחיל:${linkBlock}\nכשסיימת להעלות את הכל — כתבו לי כאן "סיימתי" ואני אעדכן את דיוה 🙂`;
    }
    case 'ack_materials':
      // The client declared completion on the /q screen (the chat path acks
      // via the bot's own materials_done action instead). Never "אושר" — only
      // Diva's review approves; the bot announces the review, not its result.
      return `קיבלתי את העדכון שהחומרים מוכנים 🙏 דיוה תעבור עליהם ותוודא שאפשר להתחיל — נעדכן אותך כאן.`;
    case 'send_start_date': {
      // The booster validates start_date as ISO before enqueueing; format it
      // for Hebrew eyes when it parses, otherwise interpolate VERBATIM — a
      // booster payload string is never "fixed" on this side.
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(payload.start_date ?? ''));
      const day = m ? `${m[3]}.${m[2]}.${m[1]}` : String(payload.start_date ?? '').trim();
      return day
        ? `יש תאריך 🎉 מתחילים לעבוד על הפרויקט שלך ב-${day}. מתרגשים לצאת לדרך 🙂`
        : `יש תאריך התחלה לפרויקט 🎉 אעדכן אותך כאן בפרטים ממש בקרוב.`;
    }
    case 'notify_live':
      // Enqueued on the panel's start_production action (work_confirmed →
      // in_production). No payload facts — so no invented links or dates.
      return `יצאנו לדרך 🚀 התחלנו לעבוד על הפרויקט שלך — אעדכן אותך כאן בכל שלב חשוב 🙂`;
    case 'ack_payment_proof':
      // DELIBERATELY null (plan flag F3): lib/payment-proof.js already sent
      // the one approved ack ('קיבלתי, בודקת ומעדכנת 🙏') the moment the
      // screenshot arrived — relaying the booster's ack too would
      // double-message the client. Null → acked and skipped, never retried.
      return null;
    default:
      return null; // unknown event → acked and skipped, never retried forever
  }
}

// Booster leads store phones as 05XXXXXXXX; Graph API wants international.
export const toWaNumber = (phone) => String(phone ?? '').replace(/\D/g, '').replace(/^0/, '972');
