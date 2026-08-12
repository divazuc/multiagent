// Leads management (ניהול לידים) — the module-catalog entry that gates the
// per-business lead board (lib/leads.js).
//
// Unlike the other modules this one is pure BOOKKEEPING: it never talks to
// the model (no context) and offers no actions for the model to request. Its
// enabled flag in business_modules is the single gate for everything the
// feature does — the pipeline's lead upserts, the coexistence echo hook, the
// trial_signup hook, and the portal's ניהול לידים tab all check it through
// lib/leads.js. Enable per business via the admin modules screen or
// scripts/enable-leads-crossfit-kids.mjs.
import { z } from 'zod';

const leadsModule = {
  key: 'leads',
  name: 'ניהול לידים',
  portalVisible: true, // the client portal shows the leads board when enabled
  settingsSchema: z.object({}).passthrough(),
  defaultSettings: {},

  // Bookkeeping only — nothing to tell the model.
  async contextProvider() { return null; },

  actions: {},

  adminUI: { fields: [] },
};

export default leadsModule;
