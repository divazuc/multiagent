// Calendar booking module — module #1 of the per-client module system.
// Offers real free slots in chat (weekly bookable hours + per-date
// overrides, filtered by the provider's freeBusy) and books via the
// structured-action protocol. Provider-agnostic: google now, outlook later.
import { z } from 'zod';
import * as google from './google.js';
import { computeSlots, formatSlotsContext, ilWallToUtc, utcToIlWall, WEEKDAYS } from './slots.js';
import { decryptSecrets } from '../crypto.js';
import { JEWISH_HOLIDAYS } from '../../holidays.js';
import { requestOwnerApproval } from '../../meeting-approval.js';

// The pending-approval marker on the event title. Created here; stripped by
// the approval route (routes/meeting-approval.js) when the owner approves —
// one constant so the two sides can never drift apart.
export const TENTATIVE_TITLE_PREFIX = '⏳ ממתין לאישור: ';

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
  // How the tentative-booking reply names the approving owner ("שלחתי לדיוה
  // לאישור"). Per-tenant data, so it lives in settings — the module itself
  // must never hardcode an owner's name. Unset → neutral phrasing.
  owner_display_name: z.string().optional(),
});

let testProvider = null;
export function _setProviderForTest(p) { testProvider = p; }
function provider(settings) {
  if (settings.provider === 'fake') {
    // Test seam + no-Google E2E mode: busy list from env, events to the log.
    return testProvider ?? {
      freeBusy: async () => JSON.parse(process.env.CALENDAR_FAKE_BUSY ?? '[]'),
      createEvent: async (_s, ev) => { console.log('[calendar-fake] createEvent', ev.title, ev.startUtcISO); return { eventId: 'fake', htmlLink: '' }; },
      getEvent: async (_s, id) => ({ title: `${TENTATIVE_TITLE_PREFIX}fake`, attendees: [], eventId: id }),
      patchEvent: async (_s, id, patch) => { console.log('[calendar-fake] patchEvent', id, patch.summary); },
      deleteEvent: async (_s, id) => { console.log('[calendar-fake] deleteEvent', id); },
    };
  }
  return google;
}

// The approval routes (routes/meeting-approval.js) patch/delete an event this
// module created — same provider resolution, same test seam.
export function providerForSettings(settings) { return provider(settings); }

// Owner-notify seam: the handler fires this without awaiting it, so a test
// injects a recorder rather than racing a fire-and-forget promise.
let ownerApproval = requestOwnerApproval;
export function _setOwnerApprovalForTest(fn) { ownerApproval = fn ?? requestOwnerApproval; }

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

import { hebDateDMY } from '../../heb-date.js';

const HEB_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

// One customer-facing rendering of a slot — day of week + dd/mm/yyyy + time
// (owner, 2026-08-29: no ISO dates in Hebrew sentences).
export function formatSlotForClient(date, from) {
  const dayName = HEB_DAYS[new Date(`${date}T00:00:00`).getDay()];
  return `${dayName ? `יום ${dayName} ` : ''}${hebDateDMY(date)} בשעה ${from}`;
}

// While the owner approves a requested slot (owner_confirmed mode), the client
// hears that it is with HER and that the bot is coming right back — in the
// tenant's own owner name from the calendar settings, never a hard-coded one
// (owner, 2026-08-29).
export function tentativeText(ownerDisplayName) {
  const owner = String(ownerDisplayName ?? '').trim();
  return owner
    ? `מעולה! העברתי את המועד ל${owner} לאישור סופי ואחזור אליך ממש בקרוב 🙏 ברגע שהמועד יאושר — יישלח לך זימון למייל.`
    : 'מעולה! העברתי את המועד לאישור סופי ואחזור אליך ממש בקרוב 🙏 ברגע שהמועד יאושר — יישלח לך זימון למייל.';
}

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
      // name is optional-and-unfailable (same rationale as the booster's
      // create_quote_lead schema): the server usually already knows it, and a
      // junk value from the model must cost the name, never the booking.
      schema: z.object({
        slot: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
        name: z.string().trim().min(1).optional().catch(undefined),
        phone: z.string().optional(),
      }),
      async handler(business, row, payload, sessionCtx) {
        const settings = settingsSchema.parse(row.settings ?? {});
        const [date, from] = payload.slot.split('T');

        // Name resolution, in trust order: what the model extracted from the
        // chat, the server-known client name (express lead — the reply
        // pipeline sets known_name from the signed quote), the WhatsApp
        // profile name. sessionCtx is server-built, never model-controlled.
        // NONE present reproduces the old required-name behaviour exactly: no
        // event and no module text — the model's own reply (which asked for a
        // name) stands alone. Tenants without any of this are unchanged.
        const name = payload.name || sessionCtx?.known_name || sessionCtx?.profile_name || null;
        if (!name) return { result: { ok: false } };

        // 1. Requested slot must be on the CURRENT computed list
        const slots = await computeCurrentSlots(row);
        const match = slots.find(s => s.date === date && s.from === from);
        const alternatives = (list) => list.slice(0, 2)
          .map(s => formatSlotForClient(s.date, s.from)).join(' או ');
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
        // A reschedule (module-action-step threads the gate's finding): the
        // confirmed meeting this booking replaces. In owner_confirmed mode it
        // rides on the approval and is replaced only when Diva approves; in
        // autonomous mode the old event goes the moment the new one exists.
        const reschedule = sessionCtx?.reschedule ?? null;
        // General seam (T6): the reply pipeline's decision layer may hand a
        // fully-formed title through sessionCtx (e.g. the express booking gate
        // names the characterization meeting after its order). Used verbatim —
        // the {name} templating only applies to the configured default. The
        // model never controls this: sessionCtx is server-built, not payload.
        const baseTitle = sessionCtx?.event_title_override
          || settings.event_title.replace('{name}', name);
        const title = (tentative ? TENTATIVE_TITLE_PREFIX : '') + baseTitle;
        // The provider's return is captured, not dropped: the approval flow
        // patches or deletes this exact event by id when the owner answers.
        const createdEvent = await provider(settings).createEvent(secrets, {
          startUtcISO: startUtc.toISOString(), endUtcISO: endUtc.toISOString(),
          title,
          description: `נקבע ע"י הסוכן בוואטסאפ.\nשם: ${name}\nטלפון: ${phone}\nעסק: ${business.name}`,
        });

        // 4. Owner notification (owner_confirmed) — non-blocking, never able
        // to fail the booking. Telegram one-tap approval when configured,
        // else the plain WhatsApp notify (see lib/meeting-approval.js).
        if (tentative) {
          Promise.resolve(ownerApproval({
            business,
            calendarRowId: row.id ?? null,
            ownerNotifyPhone: settings.owner_notify_phone ?? null,
            eventId: createdEvent?.eventId ?? null,
            phone, name, slot: payload.slot,
            quoteNumber: sessionCtx?.quote_number ?? null,
            clientEmail: sessionCtx?.client_email ?? null,
            replacesEventId: reschedule?.previousEventId ?? null,
            replacesSlot: reschedule?.previousSlot ?? null,
          })).catch(() => {});
        }

        // tentative:true is a REQUEST awaiting the owner's approval, not a
        // booking — the copy says so and so does the result, so a caller
        // cannot mistake one for the other. replaceResponse: the module copy
        // is the ENTIRE reply — the model's own text ("אני מאשרת את
        // הפגישה...") used to arrive stapled above it, promising the exact
        // opposite of "awaiting approval".
        if (tentative) {
          return {
            result: { ok: true, tentative: true, eventId: createdEvent?.eventId ?? null },
            confirmationText: tentativeText(settings.owner_display_name),
            replaceResponse: true,
          };
        }
        if (reschedule?.previousEventId) {
          await provider(settings).deleteEvent(secrets, reschedule.previousEventId).catch(e =>
            console.error('[calendar] previous event not removed after a reschedule:', e.message));
          return { result: { ok: true, tentative: false, eventId: createdEvent?.eventId ?? null },
            confirmationText: `הפגישה הוזזה! 🎉 ${formatSlotForClient(date, from)}. נתראה!` };
        }
        return { result: { ok: true, tentative: false, eventId: createdEvent?.eventId ?? null },
          confirmationText: `הפגישה נקבעה! 🎉 ${formatSlotForClient(date, from)}. נתראה!` };
      },
    },
  },

  adminUI: {
    connectType: 'google_oauth',
    fields: ['mode', 'duration_min', 'buffer_min', 'min_notice_hours', 'horizon_days', 'weekly', 'busy_calendar_ids', 'jewish_holidays_closed', 'owner_notify_phone', 'owner_display_name'],
  },
};

export default calendarModule;
