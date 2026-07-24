// Google OAuth connect flow. The link is opened by the CLIENT (not the
// admin), so these routes are public — safety comes from the HMAC state.
import { Router } from 'express';
import crypto from 'node:crypto';
import { getAuthUrl, exchangeCode } from '../lib/modules/calendar/google.js';
import { encryptSecrets } from '../lib/modules/crypto.js';

const router = Router();
const SECRET = () => process.env.PORTAL_TOKEN_SECRET ?? '';

export function signConnectState(businessId, moduleKey) {
  const payload = Buffer.from(JSON.stringify({ b: businessId, m: moduleKey, e: Date.now() + 48 * 3600 * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyConnectState(state) {
  try {
    const [payload, sig] = String(state ?? '').split('.');
    if (!payload || !sig) return null;
    const expect = crypto.createHmac('sha256', SECRET()).update(payload).digest('base64url');
    if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.e < Date.now()) return null;
    return { businessId: data.b, moduleKey: data.m };
  } catch { return null; }
}

const page = (title, body) => `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f4f6fb}div{background:#fff;padding:32px 40px;border-radius:12px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}</style></head><body><div><h2>${title}</h2><p>${body}</p></div></body></html>`;

router.get('/oauth/google/start', (req, res) => {
  const st = verifyConnectState(req.query.state);
  if (!st) return res.status(400).send(page('קישור לא תקין', 'הקישור פג תוקף או שגוי — בקשו קישור חדש.'));
  res.redirect(getAuthUrl(req.query.state));
});

router.get('/oauth/google/callback', async (req, res) => {
  const st = verifyConnectState(req.query.state);
  if (!st) return res.status(400).send(page('קישור לא תקין', 'הקישור פג תוקף או שגוי — בקשו קישור חדש.'));
  if (req.query.error) return res.status(400).send(page('החיבור בוטל', 'אפשר לסגור את החלון ולנסות שוב.'));
  try {
    const tokens = await exchangeCode(req.query.code);
    const { supabase } = await import('../lib/supabase.js');
    const { error } = await supabase.from('business_modules').upsert({
      business_id: st.businessId, module_key: st.moduleKey,
      secrets: encryptSecrets(tokens), status: 'connected', status_detail: tokens.account_email,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'business_id,module_key' });
    if (error) throw error;
    const { logModuleEvent } = await import('../lib/modules/engine.js');
    logModuleEvent(st.businessId, st.moduleKey, 'connect', { email: tokens.account_email });
    res.send(page('היומן חובר בהצלחה ✅', 'אפשר לסגור את החלון.'));
  } catch (e) {
    console.error('[oauth]', e.message);
    res.status(500).send(page('החיבור נכשל', 'משהו השתבש — נסו שוב או פנו אלינו.'));
  }
});

export default router;
