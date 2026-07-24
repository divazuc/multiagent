// Pure slot computation for the calendar module. All Dates in here are
// IL WALL CLOCK (same convention as isWithinWorkingHours in index.js);
// conversion to real UTC happens only at the Google API boundary.
const IL_TZ = 'Asia/Jerusalem';
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function utcToIlWall(d) {
  return new Date(d.toLocaleString('en-US', { timeZone: IL_TZ }));
}

// IL wall-clock of a UTC instant, expressed as if it were UTC — machine-tz
// independent (unlike new Date(localeString), which parses in machine tz).
function ilWallAsUtc(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: IL_TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const g = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return Date.UTC(+g.year, +g.month - 1, +g.day, +g.hour % 24, +g.minute, +g.second);
}

export function ilWallToUtc(dateStr, timeStr) {
  const naive = new Date(`${dateStr}T${timeStr}:00Z`).getTime(); // wall time pretending UTC
  let offset = ilWallAsUtc(naive) - naive;   // IL offset at ~that instant
  let utc = naive - offset;
  offset = ilWallAsUtc(utc) - utc;           // second pass nails DST boundaries
  return new Date(naive - offset);
}

const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const atTime = (day, t) => { const [h, m] = t.split(':').map(Number); const d = new Date(day); d.setHours(h, m, 0, 0); return d; };

export function computeSlots({ settings, busy, now, holidays }) {
  const {
    duration_min = 30, buffer_min = 0, horizon_days = 14, min_notice_hours = 3,
    weekly = {}, overrides = {}, jewish_holidays_closed = true,
  } = settings ?? {};
  const durMs = duration_min * 60000;
  const stepMs = (duration_min + buffer_min) * 60000;
  const earliest = new Date(now.getTime() + min_notice_hours * 3600000);
  const slots = [];

  for (let dayOffset = 0; dayOffset <= horizon_days; dayOffset++) {
    const day = new Date(now); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() + dayOffset);
    const key = dateKey(day);
    if (jewish_holidays_closed && holidays?.has(key)) continue;
    const windows = key in overrides ? overrides[key] : (weekly[WEEKDAYS[day.getDay()]] ?? []);
    for (const w of windows ?? []) {
      const wStart = atTime(day, w.from).getTime();
      const wEnd = atTime(day, w.to).getTime();
      for (let start = wStart; start + durMs <= wEnd; start += stepMs) {
        const end = start + durMs;
        if (start < earliest.getTime()) continue;
        const blocked = (busy ?? []).some(b => start < b.end.getTime() && end > b.start.getTime());
        if (blocked) continue;
        slots.push({ date: key, from: hhmm(new Date(start)), to: hhmm(new Date(end)) });
      }
    }
  }
  slots.sort((a, b) => (a.date + a.from).localeCompare(b.date + b.from));
  return slots;
}

const HEB_DAYS = ['יום ראשון', 'יום שני', 'יום שלישי', 'יום רביעי', 'יום חמישי', 'יום שישי', 'שבת'];
const MAX_CONTEXT_SLOTS = 40;

export function formatSlotsContext(slots, settings) {
  if (!slots?.length) {
    return `## תיאום פגישות\nאין כרגע מועדים פנויים ביומן. אם הלקוח מבקש פגישה — בקש/י שם וטלפון והסבר/י שנציג יחזור לתאם ידנית. אין להמציא מועדים.`;
  }
  const byDay = new Map();
  for (const s of slots.slice(0, MAX_CONTEXT_SLOTS)) {
    if (!byDay.has(s.date)) byDay.set(s.date, []);
    byDay.get(s.date).push(s.from);
  }
  const lines = [...byDay.entries()].map(([date, times]) => {
    const d = new Date(`${date}T00:00:00`);
    return `- ${HEB_DAYS[d.getDay()]} ${date}: ${times.join(', ')}`;
  });
  return `## תיאום פגישות (משך פגישה: ${settings.duration_min ?? 30} דק')
מועדים פנויים אמיתיים ביומן — אלה המועדים היחידים שמותר להציע (לעולם אל תמציא/י מועד אחר):
${lines.join('\n')}
כללים: הצע/י קודם את המועד הפנוי המוקדם ביותר. אם הלקוח מבקש יום/שעה אחרים — בחר/י מהרשימה בלבד.
כאשר הלקוח אישר מועד ומסר שם, הוסף/י בסוף התשובה שורה נפרדת בפורמט המדויק:
<<ACTION:calendar.book{"slot":"YYYY-MM-DDTHH:MM","name":"שם הלקוח","phone":"טלפון אם ידוע"}>>
אל תבטיח/י שהפגישה נקבעה לפני שקיבלת אישור מועד + שם. אל תציג/י את השורה הזאת ללקוח כטקסט רגיל.`;
}
