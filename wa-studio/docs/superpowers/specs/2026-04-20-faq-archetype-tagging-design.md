# FAQ Archetype Tagging — Design Spec
**Date:** 2026-04-20

## Overview

Add multi-archetype tagging to FAQ (`knowledge_items`) entries so every question can declare which business archetype(s) it belongs to — `studio`, `service`, `other`, or none (universal). Tags live on each question as a Postgres `TEXT[]` array. The starter pool in `faq-starters.js` is restructured from three parallel per-archetype lists into a single category-grouped pool, where each question carries its own `archetypes` tag. Seeding picks the subset that matches a new business's archetype plus all universal questions. The FAQ admin UI displays archetype badges on each row and lets the user edit tags inline.

---

## Global Rules

**Hard (enforced in code):**
- Archetype values are drawn from a closed set: `{studio, service, other}`.
- An empty `archetypes` array (`{}`) means **universal** — seeded for every business regardless of archetype.
- `archetypes` is `NOT NULL DEFAULT '{}'` at the DB level; missing/unknown tag input from the client is coerced to `[]`.
- Seeding never inserts a question whose `archetypes` don't match the business archetype (unless the array is empty).

**Soft (admin UI conventions):**
- Universal rows render a single neutral `כללי` badge so no row ever appears "untagged".
- Default for a newly-added FAQ via the `+ שאלה חדשה` form is `archetypes = []` (universal). The admin opts in to specific archetypes by checking boxes.

---

## Data Layer

### `knowledge_items` — new column
```sql
ALTER TABLE knowledge_items
  ADD COLUMN IF NOT EXISTS archetypes TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS knowledge_items_archetypes_idx
  ON knowledge_items USING GIN (archetypes);
```

No CHECK constraint on element values — validation happens client-side to keep the schema flexible if new archetypes are added later.

### Existing rows
All pre-existing rows receive `archetypes = '{}'` (universal) via the column default. No backfill of specific archetypes — the admin can re-tag via the UI as they curate. Inferring archetype from question text after-the-fact would be error-prone.

---

## Starter Pool Restructure

### Before (`wa-studio/src/lib/faq-starters.js`)
Three parallel constants `STUDIO_STARTERS`, `SERVICE_STARTERS`, `GENERIC_STARTERS`, each a flat array of `{ category, question, answer }`, selected at seed time by the `FAQ_STARTERS_BY_ARCHETYPE` map.

### After
Single category-grouped constant `FAQ_STARTERS_BY_CATEGORY`, where each category holds an array of `{ question, archetypes }`:

```javascript
export const FAQ_STARTERS_BY_CATEGORY = {
  pricing: [
    { question: 'כמה זה עולה?',                            archetypes: [] },
    { question: 'יש מנוי חודשי או כרטיסייה?',              archetypes: ['studio'] },
    { question: 'יש אפשרות לתשלומים?',                     archetypes: ['service'] },
    { question: 'יש הנחה לקבוצה / לחבר שמביא חבר?',        archetypes: ['studio'] },
  ],
  scheduling: [
    { question: 'מה שעות הפעילות?',         archetypes: [] },
    { question: 'יש שיעורים בסופ"ש?',       archetypes: ['studio'] },
    { question: 'אפשר לקבוע פגישה בערב?',   archetypes: ['service'] },
  ],
  booking: [
    { question: 'מתי אפשר להתחיל?',         archetypes: [] },
    { question: 'איך נרשמים לשיעור?',       archetypes: ['studio'] },
    { question: 'איך קובעים פגישה?',        archetypes: ['service'] },
    { question: 'צריך להירשם מראש?',        archetypes: [] },
  ],
  cancellation: [
    { question: 'אפשר לבטל או לשנות פגישה?',            archetypes: ['service'] },
    { question: 'אפשר לבטל שיעור? מה מדיניות הביטולים?', archetypes: ['studio'] },
    { question: 'מה קורה אם לא הגעתי?',                  archetypes: [] },
  ],
  services: [
    { question: 'איך התהליך עובד?',           archetypes: ['service'] },
    { question: 'אילו שיעורים מוצעים?',       archetypes: ['studio'] },
    { question: 'אפשר לראות עבודות קודמות?',  archetypes: ['service'] },
    { question: 'עבדתם כבר עם מקרים דומים?',  archetypes: ['service'] },
  ],
  location: [
    { question: 'איפה אתם נמצאים?',             archetypes: [] },
    { question: 'יש חניה?',                     archetypes: [] },
    { question: 'יש מקלחות במקום?',             archetypes: ['studio'] },
    { question: 'אפשר להגיע בתחבורה ציבורית?',  archetypes: [] },
  ],
  trial: [
    { question: 'יש שיעור ניסיון?',                      archetypes: ['studio'] },
    { question: 'אפשר שיחת היכרות לפני שמתחייבים?',     archetypes: ['service'] },
    { question: 'זה מתאים גם למתחילים?',                 archetypes: ['studio'] },
  ],
  general: [
    { question: 'מה צריך להביא לשיעור ראשון?',  archetypes: ['studio'] },
    { question: 'כמה זמן נמשך שיעור?',          archetypes: ['studio'] },
    { question: 'כמה זמן זה לוקח?',             archetypes: ['service'] },
    { question: 'מה צריך להכין מראש?',          archetypes: ['service'] },
    { question: 'יש ליווי לאורך כל התהליך?',   archetypes: ['service'] },
  ],
}
```

The exports `STUDIO_STARTERS`, `SERVICE_STARTERS`, `GENERIC_STARTERS`, and `FAQ_STARTERS_BY_ARCHETYPE` are **removed** — no consumer other than `supabase.js::seedFaqStarters` uses them (verified via grep prior to the design).

### Totals
| Archetype | Seeded count |
|---|---|
| studio | studio-tagged (~11) + universal (~8) ≈ 19 |
| service | service-tagged (~11) + universal (~8) ≈ 19 |
| other | universal (~8) |

---

## Seeding Logic (`supabase.js::seedFaqStarters`)

```
flatten FAQ_STARTERS_BY_CATEGORY into [{category, question, archetypes}, …]
keep item where:
  archetypes.length === 0  OR  archetypes.includes(businessArchetype)
insert row per item with:
  { business_id, category, question, answer: '', language: 'he',
    is_active: false, archetypes: item.archetypes }
```

Signature stays `seedFaqStarters(businessId, archetype)`. Behavior preserves the existing early-return when the business already has ≥1 knowledge item.

Unknown / null `archetype` (defensive case): seed only the universal subset, not the prior fallback to service starters.

---

## API Changes (`supabase.js`)

| Function | Change |
|---|---|
| `loadFaqItems(businessId)` | `SELECT` now includes `archetypes`. |
| `addFaqItem(businessId, { category, question, answer, archetypes })` | Accepts `archetypes` (default `[]`). |
| `updateFaqItem(id, updates)` | Passes `archetypes` through when present. |
| `seedFaqStarters(businessId, archetype)` | Rewritten per above. |

Client-side validation: any archetype value not in `{studio, service, other}` is dropped before insert/update.

---

## UI Changes (`FaqModal.jsx` — panel already, despite filename)

### A. Row header — archetype badges
Between the existing category badge and the question text, render one pill per archetype:

```
▸ [כללי] [סטודיו] [שירות]   כמה זמן זה לוקח?   [פעיל]   ✏️ 🗑️
```

- `archetypes.length === 0` → render a single `כללי` pill (neutral color) to signal "universal".
- Each archetype gets a distinct color class: `fq-arc-studio`, `fq-arc-service`, `fq-arc-other`, `fq-arc-universal`.
- Pills are display-only in collapsed state; editing happens in the expanded body.

### B. Expanded edit form — archetype multi-select
Below the existing category dropdown, add a checkbox group:

```
ארכיטיפ:
  ☐ סטודיו   ☐ שירות   ☐ אחר
(ללא סימון = כללי / מתאים לכל ארכיטיפ)
```

- `editState[item.id].archetypes` holds the current array.
- `onEditChange({ archetypes: [...] })` updates state; `saveEdit` persists via `updateFaqItem`.

### C. Add-new-question form (`setAddOpen`)
Same checkbox group. Default: no boxes checked → `archetypes = []`.

### D. Hebrew labels
| Key | Label |
|---|---|
| `studio` | `סטודיו` |
| `service` | `שירות` |
| `other` | `אחר` |
| universal (empty) | `כללי` |

Centralized in a new `ARCHETYPES` constant in `faq-starters.js` mirroring the existing `CATEGORIES` export.

### E. Styling
New CSS classes in `index.css`:
- `.fq-arc-badge` — base pill styling (shares shape with `.fq-cat-badge`, smaller).
- `.fq-arc-studio`, `.fq-arc-service`, `.fq-arc-other`, `.fq-arc-universal` — color variants.
- `.fq-arc-checkboxes` — inline checkbox row for edit/add forms.

---

## Testing

- **Unit (`tests/`)**: extend the harness with a scenario that exercises `seedFaqStarters` for each archetype and asserts the inserted rows match the expected subset (count + archetypes per row).
- **Manual UI smoke**:
  1. Create a new studio business → open FAQ panel → verify only studio + universal starters appear, each with correct badges.
  2. Create a new service business → verify only service + universal.
  3. Edit a row to add/remove an archetype → reload panel → verify persistence.
  4. Add a new custom question with one archetype checked → verify it saves correctly.
- **Regression**: `node tests/run.js` (current 7/7 baseline) must still pass.

---

## Migration

One-off SQL applied via Supabase REST + service role key from `wa-studio/.env` (per repo memory):

```sql
ALTER TABLE knowledge_items
  ADD COLUMN IF NOT EXISTS archetypes TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS knowledge_items_archetypes_idx
  ON knowledge_items USING GIN (archetypes);
```

Idempotent — safe to re-run. Existing rows default to `{}` (universal).

---

## Out of Scope (v1)

- Top-of-panel filter bar (`הצג: סטודיו / שירות / אחר / הכל`). Badges alone are enough; a filter can follow if the list grows long enough to need it.
- Bulk re-tagging of historical rows via script. The default `{}` is correct behavior (universal until proven otherwise); admin re-tags as they curate.
- Per-archetype default `is_active` behavior. All starters continue to seed as `is_active: false` ("pending").
- Exposing `archetypes` to WA_03 (conversation engine) for runtime filtering. The chatbot still sees all `is_active` rows for the business regardless of tag.
- A `CHECK` constraint restricting archetype values at the DB layer — deferred to avoid schema friction if the archetype vocabulary expands.
