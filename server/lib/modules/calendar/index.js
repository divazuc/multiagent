// Calendar booking module — module #1 of the per-client module system.
// Offers real free slots in chat (weekly bookable hours + per-date
// overrides, filtered by the provider's freeBusy) and books via the
// structured-action protocol. Provider-agnostic: google now, outlook later.
import { z } from 'zod';
import * as google from './google.js';
import { computeSlots, formatSlotsContext, ilWallToUtc, utcToIlWall, WEEKDAYS } from './slots.js';
import { decryptSecrets } from '../crypto.js';
import { JEWISH_HOLIDAYS } from '../../holidays.js';

const windowSchema = z.object({ from: z.string().regex(/^\d{2}:\d{2}$/), to: z.string().regex(/^\d{2}:\d{2}$/) });
const weeklyDefault = Object.fromEntries(WEEKDAYS.map(d => [d, []]));

const settingsSchema = z.object({
  provider: z.enum(['google', 'fake']).default('google'),
  mode: z.enum(['autonomous', 'owner_confirmed']).default('owner_confirmed'),
  duration_min: z.number().int().min(10).max(240).default(30),
  buffer_min: z.number().int().min(0).max(120).default(0),
  horizon_days: z.number().int().min(1).max(60).default(14),
  min_notice_hours: z.number().min(0).max(168).default(3),
  weekly: z.record(z.string(), z.array(windowSchema)).default(weeklyDefault),
  // Extra calendars consulted for AVAILABILITY only — never booked into.
  // Adding a calendar to your Google view does not merge it into primary, so
  // without this its commitments are invisible and get double-booked.
  busy_calendar_ids: z.array(z.string()).default([]),
  overrides: z.record(z.string(), z.array(windowSchema)).default({}),
  jewish_holidays_closed: z.boolean().default(true),
  event_title: z.string().default('פגישה — {name}'),
  owner_notify_phone: z.string().optional(),
});

let testProvider = null;
export function _setProviderForTest(p) { testProvider = p; }
function provider(settings) {
  if (settings.provider === 'fake') {
    // Test seam + no-Google E2E mode: busy list from env, events to the log.
    return testProvider ?? {
      freeBusy: async () => JSON.parse(process.env.CALENDAR_FAKE_BUSY ?? '[]'),
      createEvent: async (_s, ev) => { console.log('[calendar-fake] createEvent', ev.title, ev.startUtcISO); return { eventId: 'fake', htmlLink: '' }; },
    };
  }
  return google;
}

function nowIl() { return utcToIlWall(new Date()); }
const pad = (n) => String(n).padStart(2, '0');

async function busyWall(row, settings) {
  const secrets = decryptSecrets(row.secrets);
  const now = nowIl();
  const to = new Date(now); to.setDate(to.getDate() + settings.horizon_days + 1);
  const fromUtc = new Date().toISOString();
  const toUtc = ilWallToUtc(`${to.getFullYear()}-${pad(to.getMonth() + 1)}-${pad(to.getDate())}`, '23:59').toISOString();
  const busy = await provider(settings).freeBusy(secrets, fromUtc, toUtc, settings.busy_calendar_ids);
  return busy.map(b => ({ start: utcToIlWall(new Date(b.start)), end: utcToIlWall(new Date(b.end)) }));
}

async function computeCurrentSlots(row) {
  const settings = settingsSchema.parse(row.settings ?? {});
  const busy = await busyWall(row, settings);
  return computeSlots({ settings, busy, now: nowIl(), holidays: JEWISH_HOLIDAYS });
}

const HEB_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

const calendarModule = {
  key: 'calendar',
  name: 'תיאום פגישות ביומן',
  portalVisible: false, // v1: not shown in the client portal
  settingsSchema,
  defaultSettings: settingsSchema.parse({}),
  _computeCurrentSlots: computeCurrentSlots,

  async contextProvider(_business, row) {
    if (row.status !== 'connected' && row.settings?.provider !== 'fake') return null;
    const settings = settingsSchema.parse(row.settings ?? {});
    const slots = await computeCurrentSlots(row);
    return formatSlotsContext(slots, settings);
  },

  actions: {
    book: {
      schema: z.object({
        slot: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
        name: z.string().min(1),
        phone: z.string().optional(),
      }),
      async handler(business, row, payload, sessionCtx) {
        const settings = settingsSchema.parse(row.settings ?? {});
        const [date, from] = payload.slot.split('T');

        // 1. Requested slot must be on the CURRENT computed list
        const slots = await computeCurrentSlots(row);
        const match = slots.find(s => s.date === date && s.from === from);
        const alternatives = (list) => list.slice(0, 2)
          .map(s => `${HEB_DAYS[new Date(`${s.date}T00:00:00`).getDay()]} ${s.date} בשעה ${s.from}`).join(' או ');
        // Every path also returns a STRUCTURED result. The decision layer used
        // to infer success from this Hebrew copy, so a new failure string here
        // would silently have read as "booked" upstream; the text itself is
        // unchanged for every existing caller.
        if (!match) {
          return { result: { ok: false }, failureText: slots.length
            ? `המועד הזה כבר לא זמין 😕 אפשר במקום: ${alternatives(slots)}?`
            : 'המועד הזה כבר לא זמין וכרגע אין מועדים פנויים — נציג יחזור אליך לתיאום.' };
        }

        // 2. Race protection — re-verify this exact range against the live calendar
        const startUtc = ilWallToUtc(date, from);
        const endUtc = ilWallToUtc(date, match.to);
        const secrets = decryptSecrets(row.secrets);
        const busyNow = await provider(settings).freeBusy(secrets, startUtc.toISOString(), endUtc.toISOString());
        if (busyNow.length) {
          const fresh = slots.filter(s => !(s.date === date && s.from === from));
          return { result: { ok: false }, failureText: `אוי, המועד הזה בדיוק נתפס 😅 אפשר במקום: ${alternatives(fresh)}?` };
        }

        // 3. Create the event
        const phone = payload.phone || sessionCtx?.session_id || '';
        const tentative = settings.mode === 'owner_confirmed';
        // General seam (T6): the reply pipeline's decision layer may hand a
        // fully-formed title through sessionCtx (e.g. the express booking gate
        // names the characterization meeting after its order). Used verbatim —
        // the {name} templating only applies to the configured default. The
        // model never controls this: sessionCtx is server-built, not payload.
        const baseTitle = sessionCtx?.event_title_override
          || settings.event_title.replace('{name}', payload.name);
        const title = (tentative ? '⏳ ממתין לאישור: ' : '') + baseTitle;
        await provider(settings).createEvent(secrets, {
          startUtcISO: startUtc.toISOString(), endUtcISO: endUtc.toISOString(),
          title,
          description: `נקבע ע"י הסוכן בוואטסאפ.\nשם: ${payload.name}\nטלפון: ${phone}\nעסק: ${business.name}`,
        });

        // 4. Owner notification (owner_confirmed) — non-blocking
        if (tentative && settings.owner_notify_phone) {
          import('../../wa-send.js').then(({ sendWhatsAppMessage }) =>
            sendWhatsAppMessage({
              to: settings.owner_notify_phone,
              text: `📅 בקשת פגישה חדשה: ${payload.name} (${phone}) — ${date} בשעה ${from}. האירוע ביומן מסומן "ממתין לאישור".`,
              businessId: business.id,
            })).catch(() => {});
        }

        const dayName = HEB_DAYS[new Date(`${date}T00:00:00`).getDay()];
        // tentative:true is a REQUEST awaiting the owner's approval, not a
        // booking — the copy says so ("נאשר לך סופית בהקדם") and now the
        // result does too, so a caller cannot mistake one for the other.
        return { result: { ok: true, tentative }, confirmationText: tentative
          ? `רשמתי בקשה לפגישה ביום ${dayName} ${date} בשעה ${from} — נאשר לך סופית בהקדם 🙏`
          : `הפגישה נקבעה! 🎉 יום ${dayName} ${date} בשעה ${from}. נתראה!` };
      },
    },
  },

  adminUI: {
    connectType: 'google_oauth',
    fields: ['mode', 'duration_min', 'buffer_min', 'min_notice_hours', 'horizon_days', 'weekly', 'busy_calendar_ids', 'jewish_holidays_closed', 'owner_notify_phone'],
  },
};

export default calendarModule;
