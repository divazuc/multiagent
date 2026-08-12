// Platform-level Google access token from the divazuc refresh token.
//
// The calendar module (lib/modules/calendar/google.js) refreshes PER-BUSINESS
// tokens that live encrypted in module secrets — that flow stays untouched.
// This helper is the PLATFORM's own Google identity (the divazuc account that
// owns the trial-registration sheets), mirroring the booster's
// GOOGLE_REFRESH_TOKEN_DIVAZUC convention (divaz_booster lib/gmail.ts +
// lib/invoice-google.ts): refresh token in env, exchanged for a short-lived
// access token on demand, cached until just before expiry.
//
// Env (client id/secret are the SAME Google Cloud app the calendar module
// already uses — already on Railway; only the refresh token is new):
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN_DIVAZUC
//
// No secret ever appears in this file or in logs — the token endpoint's error
// body contains no credentials, and the refresh token itself is never printed.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// HTTP seam — tests record the request instead of hitting Google.
let fetchImpl = null;
export function _setFetchForTest(fn) { fetchImpl = fn; cached = null; }

let cached = null; // { token, exp } — module-level, one platform identity
export function _clearCacheForTest() { cached = null; }

export function googleSheetAuthConfigured(env = process.env) {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN_DIVAZUC);
}

export async function getGoogleAccessToken({ now = Date.now() } = {}) {
  if (!googleSheetAuthConfigured()) {
    throw new Error('Google sheet auth env missing (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN_DIVAZUC)');
  }
  if (cached && now < cached.exp) return cached.token;

  const doFetch = fetchImpl ?? fetch;
  const res = await doFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN_DIVAZUC,
      grant_type: 'refresh_token',
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error(`Google token refresh failed: ${body.error ?? res.status}`);
  }
  // Same -60s safety margin as the calendar module's accessCache.
  cached = { token: body.access_token, exp: now + Math.max(0, (body.expires_in ?? 3600) - 60) * 1000 };
  return body.access_token;
}
