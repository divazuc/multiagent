// HTTP client for the booster (divaz_booster) — seam 1 of the integration
// contract: the bot creates leads and recovers links; the booster owns all
// quote state. client_ref is derived from the phone so the same caller is
// always the same lead (idempotent create + trivial link recovery).
const BASE = () => (process.env.BOOSTER_BASE_URL ?? 'https://booster.divdev.co').replace(/\/$/, '');

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
    headers: { Authorization: `Bearer ${process.env.BOOSTER_LEAD_INTAKE_SECRET}`, 'Content-Type': 'application/json' },
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
    headers: { Authorization: `Bearer ${process.env.BOOSTER_BOT_LOOKUP_SECRET}` },
  });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`booster-client: by-ref ${res.status}`);
  return { leadId: data.lead_id, name: data.name, packageId: data.package_id, quoteUrl: data.quote_url };
}
