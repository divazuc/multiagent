import express from 'express';
import { sendWhatsAppMessage } from '../lib/wa-send.js';
import { boosterMessageFor, toWaNumber } from '../lib/booster-messages.js';

const router = express.Router();

// At-least-once delivery from the booster's outbox → in-memory dedup by
// event_id (bounded). Survives normal operation; a restart may re-send at
// most one 10-minute batch — accepted for v1 (documented in the plan).
const seen = new Set();
const remember = (id) => { seen.add(id); if (seen.size > 1000) seen.delete(seen.values().next().value); };

router.post('/booster-webhook', async (req, res) => {
  const auth = req.headers.authorization ?? '';
  if (!process.env.BOT_WEBHOOK_SECRET || auth !== `Bearer ${process.env.BOT_WEBHOOK_SECRET}`) {
    return res.status(401).json({ ok: false });
  }
  const { event_id, event, payload, lead } = req.body ?? {};
  if (!event_id || !event) return res.status(400).json({ ok: false, error: 'bad_shape' });
  if (seen.has(event_id)) return res.json({ ok: true, deduped: true });

  const text = boosterMessageFor(event, payload, lead);
  const to = toWaNumber(lead?.phone);
  if (!text || !to || to.length < 11) {
    console.warn('[booster-webhook] skipped event', event, event_id, 'to:', to);
    remember(event_id);
    return res.json({ ok: true, skipped: true }); // ack — a malformed event must not retry forever
  }
  try {
    await sendWhatsAppMessage({ to, text, businessId: process.env.DIVAZ_BUSINESS_ID ?? null });
    remember(event_id);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[booster-webhook] send failed', event_id, e.message);
    return res.status(502).json({ ok: false }); // booster retries (≤5 attempts)
  }
});

export default router;
