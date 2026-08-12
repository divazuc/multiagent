// Embedded Signup launcher — the Tech Provider onboarding page (public route).
// Serves a self-contained page that runs Meta's Embedded Signup with the
// COEXISTENCE path ("Connect a WhatsApp Business App"): the client's number
// stays on their phone's WhatsApp Business app and joins the Cloud API.
//
// Contains ONLY public identifiers (app id + ES config id — both visible in
// any ES integration by design). The signup itself requires the operator to
// log in to Facebook with an account that manages the client's business —
// nothing here grants anything by itself. Results (waba_id, phone_number_id,
// exchange code) are DISPLAYED for the operator to hand to the seed script;
// this server stores nothing from this page.
import express from 'express';

const router = express.Router();

const APP_ID = process.env.META_ES_APP_ID ?? '26092955153689878';
const CONFIG_ID = process.env.META_ES_CONFIG_ID ?? '1792485195504078';

router.get('/', (_req, res) => {
  // The global helmet CSP (script-src 'self') blocks both the Facebook SDK and
  // this page's inline launcher — override for THIS route only. The page runs
  // nothing but the ES flow, and every allowed origin below is Meta's.
  res.set('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://connect.facebook.net; " +
    "style-src 'unsafe-inline'; " +
    "connect-src https://*.facebook.com https://graph.facebook.com; " +
    "frame-src https://*.facebook.com; " +
    "img-src 'self' data: https://*.facebook.com https://*.fbcdn.net");
  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>חיבור מספר וואטסאפ — Divaz</title>
<style>
  body{font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a;margin:0;padding:32px 16px}
  .card{max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px}
  h1{font-size:20px;margin:0 0 8px}
  p{font-size:14px;color:#475569;line-height:1.6}
  button{padding:12px 24px;background:#1877f2;color:#fff;border:0;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;margin-top:12px}
  button:disabled{opacity:.5;cursor:default}
  pre{background:#f1f5f9;border-radius:8px;padding:12px;font-size:12px;direction:ltr;text-align:left;white-space:pre-wrap;word-break:break-all}
  .ok{color:#16a34a;font-weight:600}
</style></head><body>
<div class="card">
  <h1>חיבור מספר וואטסאפ לפלטפורמה</h1>
  <p>מסלול Coexistence: המספר נשאר פעיל באפליקציית WhatsApp Business בטלפון, ומתחבר גם ל-API.
  בתהליך: התחברות לפייסבוק עם החשבון שמנהל את העסק → בחירת <b>"Connect a WhatsApp Business App"</b> → סריקת QR מהטלפון של המספר.</p>
  <button id="go" disabled>התחברות והוספת מספר</button>
  <div id="out"></div>
</div>
<script>
  const out = document.getElementById('out');
  const show = (label, obj) => {
    const pre = document.createElement('pre');
    pre.textContent = label + '\\n' + JSON.stringify(obj, null, 2);
    out.appendChild(pre);
  };
  // Session-info messages from the ES popup. Diagnostic mode: record EVERY
  // facebook-origin message (raw), not just well-formed WA_EMBEDDED_SIGNUP —
  // a partial/cancelled flow is visible only through these.
  window.addEventListener('message', (event) => {
    if (!/facebook\\.com$/.test(new URL(event.origin || 'https://x.invalid').hostname)) return;
    let data = null;
    try { data = JSON.parse(event.data); } catch { /* keep raw below */ }
    if (data && data.type === 'WA_EMBEDDED_SIGNUP') {
      if (String(data.event || '').startsWith('FINISH')) {
        const p = document.createElement('p');
        p.className = 'ok';
        p.textContent = '✓ החיבור הושלם! את הערכים למטה מעבירים ל-Claude:';
        out.prepend(p);
      }
      show('SIGNUP EVENT (' + (data.event || '?') + '):', data.data ?? data);
    } else if (typeof event.data === 'string' && event.data.length < 4000 && event.data.includes('WA_')) {
      show('RAW MESSAGE:', { raw: event.data });
    }
  });
  window.fbAsyncInit = function() {
    FB.init({ appId: '${APP_ID}', autoLogAppEvents: true, xfbml: false, version: 'v23.0' });
    document.getElementById('go').disabled = false;
  };
  document.getElementById('go').addEventListener('click', () => {
    FB.login((response) => {
      if (response.authResponse?.code) show('EXCHANGE CODE:', { code: response.authResponse.code });
      else show('LOGIN RESPONSE:', response);
    }, {
      config_id: '${CONFIG_ID}',
      response_type: 'code',
      override_default_response_type: true,
      extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' },
    });
  });
</script>
<script async defer crossorigin="anonymous" src="https://connect.facebook.net/en_US/sdk.js"></script>
</body></html>`);
});

export default router;
