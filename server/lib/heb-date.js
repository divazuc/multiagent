// Dates a client reads, in a Hebrew sentence: dd/mm/yyyy. Owner, 2026-08-29 —
// "31/08/2026" (or with dashes), the ISO order was the complaint. The digits
// and ASCII separators form one left-to-right run inside RTL text, so no bidi
// marks are needed. ISO input keeps only its date part; anything that is not
// ISO passes through untouched — a booster payload string is never "fixed".
export function hebDateDMY(value) {
  const s = String(value ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}
