/**
 * Archetype starter FAQ packs.
 *
 * These are seeded into `knowledge_items` automatically when a business
 * completes setup. The business owner can review / edit / add before
 * the onboarding conversation (WA_08) and before going live (WA_03).
 *
 * Schema reference:
 *   knowledge_items { business_id, category, question, answer, language, is_active }
 *
 * Instructions for filling in:
 *   - question: write as a customer would actually send it on WhatsApp (informal, Hebrew)
 *   - answer:   write as the agent should respond — complete, friendly, on-brand
 *   - category: use the category slugs defined in CATEGORIES below
 *   - Keep answers short enough for WhatsApp (2–4 sentences max)
 *   - Add as many items per category as you need — no fixed limit
 */

// ─── Categories ────────────────────────────────────────────────────────────────
// These appear as filter/group labels in the wa-studio FAQ editor.

export const CATEGORIES = {
  pricing:      'תמחור',
  scheduling:   'שעות ולוח זמנים',
  booking:      'הזמנה ורישום',
  services:     'שירותים ומוצרים',
  location:     'מיקום ונגישות',
  cancellation: 'ביטול ושינויים',
  trial:        'ניסיון והיכרות',
  general:      'כללי',
}

// ─── Studio archetype ──────────────────────────────────────────────────────────
// Suitable for: fitness studios, yoga, dance, martial arts, pilates, etc.

export const STUDIO_STARTERS = [
  {
    category: 'general',
    question: 'מה צריך להביא לשיעור ראשון?',
    answer:   '',
  },
  {
    category: 'general',
    question: 'כמה זמן נמשך שיעור?',
    answer:   '',
  },
  {
    category: 'general',
    question: 'יש מקלחות במקום?',
    answer:   '',
  },
  // Add more items here ↓
]

// ─── Service / Professional archetype ─────────────────────────────────────────
// Suitable for: consultants, therapists, freelancers, contractors, clinics, etc.

export const SERVICE_STARTERS = [
  {
    category: 'booking',
    question: 'מתי אפשר להתחיל?',
    answer:   '',
  },
  {
    category: 'cancellation',
    question: 'אפשר לבטל או לשנות פגישה?',
    answer:   '',
  },
  {
    category: 'general',
    question: 'איך התהליך עובד?',
    answer:   '',
  },
  {
    category: 'general',
    question: 'כמה זמן זה לוקח?',
    answer:   '',
  },
  {
    category: 'general',
    question: 'מה צריך להכין מראש?',
    answer:   '',
  },
  {
    category: 'general',
    question: 'עבדתם כבר עם מקרים דומים?',
    answer:   '',
  },
  {
    category: 'general',
    question: 'אפשר לראות עבודות קודמות?',
    answer:   '',
  },
  {
    category: 'general',
    question: 'זה מתאים גם למתחילים?',
    answer:   '',
  },
  {
    category: 'general',
    question: 'יש ליווי לאורך כל התהליך?',
    answer:   '',
  },
  // Add more items here ↓
]

// ─── Generic / Other archetype ─────────────────────────────────────────────────
// Fallback for businesses that don't fit studio or service.

export const GENERIC_STARTERS = [
  {
    category: 'general',
    question: '', // e.g. "מה אתם עושים?"
    answer:   '', // e.g. "אנחנו [תיאור קצר]. שלחו לי שאלה ואשמח לעזור!"
  },
  {
    category: 'pricing',
    question: '',
    answer:   '',
  },
  {
    category: 'booking',
    question: '',
    answer:   '',
  },
  {
    category: 'general',
    question: '',
    answer:   '',
  },
  // Add more items here ↓
]

// ─── Archetype → starter pack map ─────────────────────────────────────────────
// Used by the FAQ seeder when setup commits.

export const FAQ_STARTERS_BY_ARCHETYPE = {
  studio:      STUDIO_STARTERS,
  service:     SERVICE_STARTERS,
  other:       GENERIC_STARTERS,
}
