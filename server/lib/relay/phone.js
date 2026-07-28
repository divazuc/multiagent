// Phones are stored digits-only (E.164 without '+'). Production still holds
// unnormalised values like '054-8139333' in the legacy contact columns; every
// write through this feature goes through here.
const IL_COUNTRY = '972';

export function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  let digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('0')) digits = IL_COUNTRY + digits.slice(1);
  return /^\d{10,15}$/.test(digits) ? digits : null;
}
