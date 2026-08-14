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
      // valid_days is the PRE-SIGNATURE LINK window — how long the client has
      // to open the link and sign. 14 days on express, 30 on the
      // questionnaire/self_serve track, so the payload always wins and the
      // fallback is the express default.
      //
      // Do NOT "unify" this to 30. Three windows in this funnel wear the same
      // two digits while measuring different things from different events:
      //   1. THIS one — the link, counted from when it was issued (14 express)
      //   2. quote validity — 30 days, counted FROM THE SIGNATURE
      //   3. the payment deadline — 14 days, contractual
      // A previous pass moved this to 30 by reading (2) as if it were (1).
      return `היי ${first} 👋\nהכנתי לך קישור אישי לבניית הצעת המחיר שלך:\n${payload.link_url}\n\nהקישור אישי ותקף ל-${payload.valid_days ?? 14} ימים. אפשר לשחק עם התוספות ולראות מחיר מעודכן בכל שלב 🙂`;
    case 'send_signed_summary':
      return `תודה ${first}! ההצעה ${payload.quote_number} נחתמה 🎉\nסה"כ לתשלום: ${nis(payload.total)} (כולל מע"מ).\nעותק חתום נשלח למייל שלך.\n\n${nextStepLine(payload)}`;
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
    case 'send_expiry_notice': {
      // booster's app/api/express/expiry route enqueues this with reason
      // 'unsigned_14d' | 'unsigned_30d' | 'materials_3m' (see divaz_booster
      // lib/express/leads.ts + app/api/express/expiry/route.ts).
      //
      // Both unsigned_* reasons are LIVE and neither is legacy: they are the
      // same clock — the PRE-SIGNATURE link window — on two tracks, express
      // expiring at 14 days and questionnaire/self_serve at 30. Both mean
      // "your link expired" and take the same text.
      //
      // The materials_* reasons are a different animal: the client DID pay, so
      // "your link expired" is not merely off-tone, it is false — and it buries
      // the money question they actually have. They get their own copy:
      //   • materials_3m — the CURRENT contractual window (3 months from
      //     payment+meeting). The order closes with a refund less a handling
      //     fee, and the booster puts that already-formatted Hebrew sentence on
      //     payload.refund. Interpolate it VERBATIM: the booster owns the money
      //     wording, this side never reformats or re-derives it (same rule as
      //     payment_details above). With no `refund` we say the details are
      //     coming from דיוה — an amount is never invented here.
      //   • materials_30d — the SUPERSEDED 30-day/one-year-credit policy, kept
      //     only so an outbox row enqueued under the old rule still reads
      //     truthfully instead of falling through to "your link expired".
      // Everything else — both unsigned_ variants, a future cutoff, no reason
      // at all — is a plain link-expired notice, matched with a catch-all
      // rather than an explicit list so nothing ever falls through unhandled.
      // A materials-shaped reason we do not know is NOT guessed into a closure.
      if (payload.reason === 'materials_3m') {
        const refund = String(payload.refund ?? '').trim();
        const closed = `ההזמנה נסגרה — החומרים לא התקבלו בתוך שלושת החודשים שנקבעו בהסכם 📄`;
        return refund
          ? `${closed}\n${refund}\nלכל שאלה על הסגירה אפשר לכתוב לי כאן ואעביר לדיוה 🙂`
          : `${closed}\nפרטי הסגירה יגיעו ישירות מדיוה 🙏 אם יש שאלה — אפשר לכתוב לי כאן.`;
      }
      if (payload.reason === 'materials_30d') {
        return `חלון 30 הימים להעברת החומרים חלף, ולכן ההזמנה נסגרה — התשלום ששולם נזקף כקרדיט לשנה מהיום 💳\nרוצים לחדש ולהמשיך? רק תכתבו לי כאן ונסדר את זה יחד 🙂`;
      }
      return `הקישור להצעת המחיר שלך פג תוקף ⏳ אם עדיין רלוונטי — כתבו לי כאן ונשמח לחדש אותו.`;
    }
    // ── Materials stage (funnel track 1, T8) ─────────────────────────────────
    // Payload per the booster's meeting-before-payment plan Task 9 + the client
    // personal area (vault spec 19, phase A):
    // { quote_number, folder_url, materials_doc_url, content_doc_url, page_url }
    // — older events may arrive with only { package_id }, so every link line is
    // optional and an empty/missing URL is skipped, never printed blank.
    // No prices, no payment talk: by this stage payment is behind us.
    // With page_url the declaration path is the project page's button (spec 19
    // decision; the chat "סיימתי" stays a secondary path); without it the copy
    // falls back to the old chat instruction.
    case 'send_materials_checklist': {
      const links = [
        ['🏠 עמוד הפרויקט שלך', payload.page_url],
        ['📁 תיקיית החומרים שלך', payload.folder_url],
        ['📋 מסמך הנחיות החומרים', payload.materials_doc_url],
        ['📝 מסמך התכנים למילוי', payload.content_doc_url],
      ].filter(([, url]) => typeof url === 'string' && url.trim() !== '');
      const orderRef = payload.quote_number ? ` להזמנה ${payload.quote_number}` : '';
      const linkBlock = links.length
        ? `\n${links.map(([label, url]) => `${label}: ${url}`).join('\n')}\n`
        : '\n';
      const hasPage = typeof payload.page_url === 'string' && payload.page_url.trim() !== '';
      const closing = hasPage
        ? 'כשסיימתם להעלות ולמלא הכל — לוחצים בעמוד הפרויקט על "סיימתי לערוך תכנים" וזה מעדכן את דיוה מיד 🙂'
        : 'כשסיימת להעלות את הכל — כתבו לי כאן "סיימתי" ואני אעדכן את דיוה 🙂';
      return `עוברים לשלב החומרים${orderRef} 🙌 הכנתי לך את כל מה שצריך כדי שנוכל להתחיל:${linkBlock}\n${closing}`;
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
