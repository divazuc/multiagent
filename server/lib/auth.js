// Operator-endpoint authentication (SECURITY_AUDIT_SPEC A-01/A-02).
// Everything except the public surface (/health, the Meta webhook, and the
// portal which carries its own token auth) requires the admin API key.
// Enforcement is gated on STUDIO_AUTH_REQUIRED so the server can deploy
// before the frontend ships its Authorization header — flip the flag on
// Railway once both sides are live.

import crypto from 'node:crypto';

const PUBLIC_PATHS = ['/health', '/wa-inbound'];
const PUBLIC_PREFIXES = ['/portal/'];

let warnedOff = false;

export function studioAuth(req, res, next) {
  if (process.env.STUDIO_AUTH_REQUIRED !== 'true') {
    if (!warnedOff) {
      console.warn('[auth] STUDIO_AUTH_REQUIRED is not "true" — operator endpoints are OPEN');
      warnedOff = true;
    }
    return next();
  }

  if (PUBLIC_PATHS.includes(req.path) || PUBLIC_PREFIXES.some(p => req.path.startsWith(p))) {
    return next();
  }

  const key = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const expected = process.env.ADMIN_API_KEY ?? '';
  try {
    if (expected && key.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected))) {
      return next();
    }
  } catch { /* length mismatch */ }

  return res.status(401).json({ status: 'error', message: 'unauthorized' });
}
