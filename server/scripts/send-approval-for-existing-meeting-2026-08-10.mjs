// One-off (2026-08-10): mint a Telegram approval for the meeting request that
// was created BEFORE the approval feature deployed (Thursday 2026-08-13 12:00,
// order DZ-2026-1905) — so Diva can live-test the one-tap flow on it.
//
// Finds the tentative event in the live Google Calendar (its id was not
// captured back then), then reuses the production lib verbatim:
// createMeetingApproval + sendTelegramApproval. No secrets in this file —
// everything comes from env.
//
//   TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… PUBLIC_BASE_URL=… \
//     node --env-file=.env.local scripts/send-approval-for-existing-meeting-2026-08-10.mjs
import { supabase } from '../lib/supabase.js';
import { decryptSecrets } from '../lib/modules/crypto.js';
import { createMeetingApproval, sendTelegramApproval, telegramConfigured } from '../lib/meeting-approval.js';

const BIZ = '86efa161-9af8-45c1-924f-6ec39850f114'; // Diva Ost
const SLOT = '2026-08-13T12:00';                    // IL wall time
const QUOTE = 'DZ-2026-1905';
const NAME = 'דיוה טוסט';
const PHONE = '972528250088';
const CLIENT_EMAIL = 'divazuc@gmail.com';           // signer_email of the signed quote

if (!telegramConfigured()) { console.error('TELEGRAM env missing'); process.exit(1); }

const { data: row, error } = await supabase.from('business_modules')
  .select('business_id, module_key, settings, secrets')
  .eq('business_id', BIZ).eq('module_key', 'calendar').maybeSingle();
if (error || !row) { console.error('calendar module row not found:', error?.message); process.exit(1); }
const secrets = decryptSecrets(row.secrets);

// Access token — same refresh flow as lib/modules/calendar/google.js.
const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    refresh_token: secrets.refresh_token, client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token',
  }),
});
const tokenBody = await tokenRes.json();
if (!tokenRes.ok) { console.error('token refresh failed:', tokenBody.error); process.exit(1); }

// 12:00 IL in August = 09:00Z; scan a wide window around it to be safe.
const list = await (await fetch(
  'https://www.googleapis.com/calendar/v3/calendars/primary/events?' + new URLSearchParams({
    timeMin: '2026-08-13T05:00:00Z', timeMax: '2026-08-13T12:00:00Z', singleEvents: 'true',
  }), { headers: { Authorization: `Bearer ${tokenBody.access_token}` } })).json();
const ev = (list.items ?? []).find(e => (e.summary ?? '').includes('ממתין לאישור'));
if (!ev) { console.error('no tentative event found on 2026-08-13; summaries:', (list.items ?? []).map(e => e.summary)); process.exit(1); }
console.log('found event:', ev.id, '—', ev.summary);

const token = await createMeetingApproval({
  businessId: BIZ, eventId: ev.id, calendarRowId: null,
  phone: PHONE, name: NAME, slot: SLOT, quoteNumber: QUOTE, clientEmail: CLIENT_EMAIL,
});
if (!token) { console.error('approval record not created'); process.exit(1); }

const sent = await sendTelegramApproval({ token, name: NAME, phone: PHONE, slot: SLOT, quoteNumber: QUOTE });
console.log(sent ? 'TELEGRAM SENT — check the chat' : 'telegram send FAILED');
process.exit(sent ? 0 : 1);
