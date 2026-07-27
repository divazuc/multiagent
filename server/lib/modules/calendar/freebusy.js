// Which calendars to ask Google about, and how to read the answer.
//
// The first version asked only for `primary` and read only `calendars.primary.busy`.
// That is wrong whenever the owner keeps commitments in a second calendar: adding
// a calendar to your Google Calendar view does NOT merge its events into primary,
// so those hours stayed invisible and the bot offered meetings on top of them.
// Measured on a real account: primary held 1 busy block over 14 days while the
// owner's personal calendar held 22.
//
// Booking still targets primary only — extra calendars are consulted for
// availability, never written to.

export function freeBusyItems(extraCalendarIds = []) {
  const seen = new Set(['primary']);
  const items = [{ id: 'primary' }];
  for (const raw of extraCalendarIds ?? []) {
    const id = String(raw ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    items.push({ id });
  }
  return items;
}

// Google reports per-calendar errors inline (a calendar the account cannot
// freeBusy comes back with `errors: [{reason:'notFound'}]`). Skip those rather
// than failing the whole availability check over one bad id.
export function mergeBusy(body) {
  const calendars = body?.calendars;
  if (!calendars || typeof calendars !== 'object') return [];
  const out = [];
  for (const entry of Object.values(calendars)) {
    if (entry?.errors?.length) continue;
    for (const b of entry?.busy ?? []) out.push({ start: b.start, end: b.end });
  }
  return out;
}
