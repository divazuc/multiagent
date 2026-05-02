// Israeli Yom Tov days (full closures) for 5785–5786 (2024–2026)
// Includes only days when businesses are typically closed (not Chanukah/Purim)
export const JEWISH_HOLIDAY_DATES = [
  // 5785 — 2024/2025
  { date: '2024-10-02', name: 'ראש השנה א׳ / Rosh Hashana I' },
  { date: '2024-10-03', name: 'ראש השנה ב׳ / Rosh Hashana II' },
  { date: '2024-10-11', name: 'ערב יום כיפור / Yom Kippur eve' },
  { date: '2024-10-12', name: 'יום כיפור / Yom Kippur' },
  { date: '2024-10-16', name: 'סוכות א׳ / Sukkot I' },
  { date: '2024-10-17', name: 'סוכות ב׳ / Sukkot II' },
  { date: '2024-10-23', name: 'שמיני עצרת / Shmini Atzeret' },
  { date: '2024-10-24', name: 'שמחת תורה / Simchat Torah' },
  { date: '2025-04-12', name: 'פסח א׳ / Passover I' },
  { date: '2025-04-13', name: 'פסח ב׳ / Passover II' },
  { date: '2025-04-18', name: 'פסח ז׳ / Passover VII' },
  { date: '2025-04-19', name: 'פסח ח׳ / Passover VIII' },
  { date: '2025-06-01', name: 'שבועות א׳ / Shavuot I' },
  { date: '2025-06-02', name: 'שבועות ב׳ / Shavuot II' },

  // 5786 — 2025/2026
  { date: '2025-09-22', name: 'ראש השנה א׳ / Rosh Hashana I' },
  { date: '2025-09-23', name: 'ראש השנה ב׳ / Rosh Hashana II' },
  { date: '2025-10-01', name: 'ערב יום כיפור / Yom Kippur eve' },
  { date: '2025-10-02', name: 'יום כיפור / Yom Kippur' },
  { date: '2025-10-06', name: 'סוכות א׳ / Sukkot I' },
  { date: '2025-10-07', name: 'סוכות ב׳ / Sukkot II' },
  { date: '2025-10-13', name: 'שמיני עצרת / Shmini Atzeret' },
  { date: '2025-10-14', name: 'שמחת תורה / Simchat Torah' },
  { date: '2026-04-01', name: 'פסח א׳ / Passover I' },
  { date: '2026-04-02', name: 'פסח ב׳ / Passover II' },
  { date: '2026-04-07', name: 'פסח ז׳ / Passover VII' },
  { date: '2026-04-08', name: 'פסח ח׳ / Passover VIII' },
  { date: '2026-05-21', name: 'שבועות א׳ / Shavuot I' },
  { date: '2026-05-22', name: 'שבועות ב׳ / Shavuot II' },
]

// Returns the next N upcoming holidays from today
export function upcomingHolidays(n = 3) {
  const today = new Date().toISOString().slice(0, 10)
  return JEWISH_HOLIDAY_DATES.filter(h => h.date >= today).slice(0, n)
}

// Returns true if the given YYYY-MM-DD string is a Jewish holiday
export function isJewishHoliday(dateStr) {
  return JEWISH_HOLIDAY_DATES.some(h => h.date === dateStr)
}
