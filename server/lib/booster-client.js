// HTTP client for the booster (divaz_booster) — seam 1 of the integration
// contract: the bot creates leads and recovers links; the booster owns all
// quote state. client_ref is derived from the phone so the same caller is
// always the same lead (idempotent create + trivial link recovery).
const BASE = () => (process.env.BOOSTER_BASE_URL ?? 'https://booster.divdev.co').replace(/\/$/, '');

// Production sits behind a Cloudflare Access app that requires service-token
// headers (booster repo memory: 'divazuc-lead-intake-access'); local dev has
// no Access in front of it, so the headers are optional there.
const cfAccessHeaders = () => {
  const id = process.env.BOOSTER_CF_ACCESS_CLIENT_ID;
  const secret = process.env.BOOSTER_CF_ACCESS_CLIENT_SECRET;
  return id && secret ? { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret } : {};
};

export function normalizeIlPhone(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.startsWith('972')) d = '0' + d.slice(3);
  return /^0\d{8,9}$/.test(d) ? d : null;
}

export const boosterClientRef = (phone) => `wa-${normalizeIlPhone(phone)}`;

export async function createBoosterLead({ name, phone, email, packageId, businessNote, utm = {} }) {
  const normalized = normalizeIlPhone(phone);
  if (!normalized) throw new Error(`booster-client: bad phone ${phone}`);
  const res = await fetch(`${BASE()}/api/leads`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.BOOSTER_LEAD_INTAKE_SECRET}`, 'Content-Type': 'application/json', ...cfAccessHeaders() },
    body: JSON.stringify({
      client_ref: boosterClientRef(normalized), name, phone: normalized, email,
      package_id: packageId, business_note: businessNote ?? undefined,
      source: 'whatsapp_bot', attribution: utm,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`booster-client: POST /api/leads ${res.status} ${data.error ?? ''}`);
  return { leadId: data.lead_id, linkUrl: data.link_url, created: data.status === 'created' };
}

export async function lookupBoosterLeadByPhone(phone) {
  const normalized = normalizeIlPhone(phone);
  if (!normalized) return null;
  const res = await fetch(`${BASE()}/api/leads/by-ref/${boosterClientRef(normalized)}`, {
    headers: { Authorization: `Bearer ${process.env.BOOSTER_BOT_LOOKUP_SECRET}`, ...cfAccessHeaders() },
  });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`booster-client: by-ref ${res.status}`);
  // status (Task 17) lets a caller gate on lifecycle stage — e.g. only a lead
  // sitting at awaiting_payment/payment_proof_sent accepts a forwarded screenshot.
  return { leadId: data.lead_id, name: data.name, packageId: data.package_id, quoteUrl: data.quote_url, status: data.status };
}

// Task 17: the client sent a payment-confirmation screenshot in WhatsApp — forward
// it to the booster, which owns storage, the payment_proof_sent transition, and
// Diva's Telegram alert. Payload shape mirrors the booster's bot-friendly JSON+
// base64 route (app/api/leads/[id]/payment-proof/route.ts), not multipart.
// T5 (funnel track 1): the client said "סיימתי" in chat — tell the booster,
// which owns the awaiting_materials → materials_declared transition and
// Diva's Telegram ping (no ack_materials back: the bot already acked in
// chat). Contract: 200 {ok, status} / {ok, already:true} on a repeat;
// 409 wrong_status and 401/404 throw so the caller can answer honestly.
export async function declareMaterialsDone({ leadId, note }) {
  const trimmed = typeof note === 'string' && note.trim() ? note.slice(0, 2000) : null;
  const res = await fetch(`${BASE()}/api/leads/${leadId}/materials-declared`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.BOOSTER_BOT_LOOKUP_SECRET}`, 'Content-Type': 'application/json', ...cfAccessHeaders() },
    body: JSON.stringify(trimmed ? { note: trimmed } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`booster-client: materials-declared ${res.status} ${data.error ?? ''}`);
  return { already: data.already === true, status: data.status ?? null };
}

export async function forwardPaymentProof({ leadId, imageBase64, mime, caption }) {
  const res = await fetch(`${BASE()}/api/leads/${leadId}/payment-proof`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.BOOSTER_BOT_LOOKUP_SECRET}`, 'Content-Type': 'application/json', ...cfAccessHeaders() },
    body: JSON.stringify({ image_base64: imageBase64, mime, ...(caption ? { caption } : {}) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`booster-client: payment-proof ${res.status} ${data.error ?? ''}`);
  return { screenshotId: data.screenshot_id };
}
