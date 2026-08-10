// Google Calendar REST v3 — no googleapis dep, plain fetch.
// secrets shape (decrypted): { refresh_token, account_email }
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
import { freeBusyItems, mergeBusy } from './freebusy.js';

const API ='https://www.googleapis.com/calendar/v3';
export const SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly';

const accessCache = new Map(); // refresh_token -> {token, exp}

function redirectUri() {
  return `${process.env.PUBLIC_BASE_URL ?? 'https://wagent.divdev.co'}/oauth/google/callback`;
}

export function getAuthUrl(state) {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code', scope: SCOPES, access_type: 'offline', prompt: 'consent', state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function exchangeCode(code) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(), grant_type: 'authorization_code',
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.refresh_token) throw new Error(`token exchange failed: ${body.error ?? res.status}`);
  let email = '';
  try {
    const info = await (await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${body.access_token}` } })).json();
    email = info.email ?? '';
  } catch { /* email is cosmetic */ }
  return { refresh_token: body.refresh_token, account_email: email };
}

async function accessToken(secrets) {
  const cached = accessCache.get(secrets.refresh_token);
  if (cached && cached.exp > Date.now()) return cached.token;
  const res = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: secrets.refresh_token, client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token',
    }),
  });
  const body = await res.json();
  if (!res.ok) { const e = new Error(`TOKEN_ERROR: ${body.error ?? res.status}`); e.code = 'TOKEN_ERROR'; throw e; }
  accessCache.set(secrets.refresh_token, { token: body.access_token, exp: Date.now() + (body.expires_in - 60) * 1000 });
  return body.access_token;
}

export async function freeBusy(secrets, fromUtcISO, toUtcISO, extraCalendarIds = []) {
  const token = await accessToken(secrets);
  const res = await fetch(`${API}/freeBusy`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeMin: fromUtcISO, timeMax: toUtcISO, items: freeBusyItems(extraCalendarIds) }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`freeBusy failed: ${body.error?.message ?? res.status}`);
  return mergeBusy(body);
}

export async function createEvent(secrets, { startUtcISO, endUtcISO, title, description }) {
  const token = await accessToken(secrets);
  const res = await fetch(`${API}/calendars/primary/events`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: title, description,
      start: { dateTime: startUtcISO }, end: { dateTime: endUtcISO },
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`createEvent failed: ${body.error?.message ?? res.status}`);
  return { eventId: body.id, htmlLink: body.htmlLink ?? '' };
}

// The approval flow reads the event back before patching it: PATCH replaces
// `attendees` wholesale, so adding one requires knowing the current list.
export async function getEvent(secrets, eventId) {
  const token = await accessToken(secrets);
  const res = await fetch(`${API}/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`getEvent failed: ${body.error?.message ?? res.status}`);
  return { eventId: body.id, title: body.summary ?? '', attendees: body.attendees ?? [] };
}

// sendUpdates:'all' is what makes Google e-mail the invite to a just-added
// attendee — the whole point of approving with the client's address known.
export async function patchEvent(secrets, eventId, { title, attendees }, { sendUpdates = 'none' } = {}) {
  const token = await accessToken(secrets);
  const patch = {};
  if (title !== undefined) patch.summary = title;
  if (attendees !== undefined) patch.attendees = attendees;
  const res = await fetch(`${API}/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=${encodeURIComponent(sendUpdates)}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`patchEvent failed: ${body.error?.message ?? res.status}`);
  return { eventId: body.id };
}

export async function deleteEvent(secrets, eventId) {
  const token = await accessToken(secrets);
  const res = await fetch(`${API}/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
  });
  // DELETE answers 204 with an empty body; 410 means already gone — for a
  // reschedule that released the slot either way, both count as deleted.
  if (!res.ok && res.status !== 410) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`deleteEvent failed: ${body.error?.message ?? res.status}`);
  }
}
