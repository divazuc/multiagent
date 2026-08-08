// Hebrew WhatsApp copy per booster event. payload fields come from the
// booster's outbox (see divaz_booster lib/express/freeze.ts + leads.ts).
const nis = (n) => `₪${Math.round(Number(n) || 0).toLocaleString('he-IL')}`;

export function boosterMessageFor(event, payload = {}, lead = {}) {
  const first = (lead.name ?? '').trim().split(/\s+/)[0] || '';
  switch (event) {
    case 'send_personal_link':
      return `היי ${first} 👋\nהכנתי לך קישור אישי לבניית הצעת המחיר שלך:\n${payload.link_url}\n\nהקישור אישי אלייך ותקף ל-${payload.valid_days ?? 14} ימים. אפשר לשחק עם התוספות ולראות מחיר מעודכן בכל שלב 🙂`;
    case 'send_signed_summary':
      return `תודה ${first}! ההצעה ${payload.quote_number} נחתמה 🎉\nסה"כ לתשלום: ${nis(payload.total)} (כולל מע"מ).\nעותק חתום נשלח אלייך במייל.`;
    case 'send_payment_details':
      return payload.payment_details
        ? `להשלמת התשלום עבור ${payload.quote_number}:\n${payload.payment_details}\n\nאחרי התשלום — שלחו לי כאן צילום מסך של האישור, ונאשר תוך יום עסקים 🙏`
        : `להשלמת התשלום עבור ${payload.quote_number} (${nis(payload.total)}) — פרטי התשלום מופיעים בעמוד ההצעה שלך. אחרי התשלום שלחו לי כאן צילום של האישור 🙏`;
    case 'send_payment_reminder':
      return `תזכורת קטנה 🙂 ההצעה ${payload.quote_number} (${nis(payload.total)}) ממתינה להשלמת תשלום. אם כבר שילמתם — שלחו לי צילום של האישור ואקדם את הפרויקט.`;
    case 'send_expiry_notice':
      return `הקישור להצעת המחיר שלך פג תוקף ⏳ אם עדיין רלוונטי — כתבו לי כאן ונשמח לחדש אותו.`;
    default:
      return null; // unknown event → acked and skipped, never retried forever
  }
}

// Booster leads store phones as 05XXXXXXXX; Graph API wants international.
export const toWaNumber = (phone) => String(phone ?? '').replace(/\D/g, '').replace(/^0/, '972');
