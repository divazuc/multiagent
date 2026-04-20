# FAQ Archetype Tagging — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tag every FAQ/knowledge-base question with the business archetypes it applies to (`studio`, `service`, `other`, or universal), so seeding picks the right subset per business and the admin UI shows/edit archetype badges inline.

**Architecture:** New `archetypes TEXT[]` column on `knowledge_items` (empty array = universal). Starter pool in `wa-studio/src/lib/faq-starters.js` refactors from three per-archetype flat lists into one category-grouped pool where each question declares its own `archetypes`. A pure filter function drives seeding. The admin panel (`FaqModal.jsx`) gains read-only badges on each row and a checkbox multi-select in the edit + add forms.

**Tech Stack:** React 18, Vite, Supabase JS client, Postgres (Supabase), vanilla CSS, Node built-in `assert` for unit tests. No new dependencies.

**Spec:** `wa-studio/docs/superpowers/specs/2026-04-20-faq-archetype-tagging-design.md`

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `wa-studio/src/lib/faq-starters.js` | Rewrite | Owns archetype vocabulary, the category-grouped starter pool, and the pure `filterStartersForArchetype` helper. |
| `wa-studio/tests/unit/faq-starters.test.js` | Create | Node built-in test for the pure filter helper. No DB, no network. |
| `wa-studio/src/lib/supabase.js` | Modify | `seedFaqStarters` rewritten to use the pure filter; `loadFaqItems` / `addFaqItem` / `updateFaqItem` carry `archetypes`. |
| `wa-studio/src/components/FaqModal.jsx` | Modify | Archetype badges on each collapsed row; checkbox multi-select in edit + add forms. |
| `wa-studio/src/index.css` | Modify | New `.fq-arc-*` pill styles + `.fq-arc-checkboxes` layout. |
| `wa-studio/package.json` | Modify | Add `test:unit` script so the new unit test participates in the regular workflow. |

---

## Task 1: DB Migration — add `archetypes` column

**Files:**
- Run: ad-hoc SQL via Supabase REST (no file committed; idempotent)

- [ ] **Step 1: Confirm service-role key is available**

Check that `wa-studio/.env` contains `SUPABASE_SERVICE_ROLE_KEY` (per repo memory convention).

Run:
```bash
grep -c '^SUPABASE_SERVICE_ROLE_KEY=' wa-studio/.env
```
Expected: `1`. If `0`, stop and ask the user to add the key before proceeding.

- [ ] **Step 2: Apply migration SQL**

The migration is one statement + one index:
```sql
ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS archetypes TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS knowledge_items_archetypes_idx ON knowledge_items USING GIN (archetypes);
```

Try these paths in order — use the first that works:

**(a) psql via `DATABASE_URL` if present in `wa-studio/.env`:**
```bash
DB_URL=$(grep -E '^(DATABASE_URL|POSTGRES_URL)=' wa-studio/.env | head -1 | cut -d= -f2-)
[ -n "$DB_URL" ] && psql "$DB_URL" -c "ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS archetypes TEXT[] NOT NULL DEFAULT '{}'; CREATE INDEX IF NOT EXISTS knowledge_items_archetypes_idx ON knowledge_items USING GIN (archetypes);"
```

**(b) Supabase REST RPC `exec_sql` (only if the project exposes one):**
```bash
SERVICE_KEY=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' wa-studio/.env | cut -d= -f2-)
SUPA_URL=$(grep '^VITE_SUPABASE_URL=' wa-studio/.env | cut -d= -f2-)
curl -sS -X POST "${SUPA_URL}/rest/v1/rpc/exec_sql" \
  -H "apikey: ${SERVICE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"sql":"ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS archetypes TEXT[] NOT NULL DEFAULT ''{}''; CREATE INDEX IF NOT EXISTS knowledge_items_archetypes_idx ON knowledge_items USING GIN (archetypes);"}'
```
Expected: HTTP 200, empty/null body. A 404 means this RPC doesn't exist — try path (c).

**(c) Supabase MCP server** (if connected): call `mcp__plugin_supabase_supabase__*` to execute the SQL.

**(d) Last resort:** write the SQL to `wa-studio/docs/sql/2026-04-20-faq-archetypes.sql` for the human to paste into the SQL Editor, and flag this to the user in the final summary. Do NOT block later tasks — the column can be added out-of-band while the code changes are still reviewable.

- [ ] **Step 3: Verify the column exists**

Run:
```bash
curl -sS "${SUPA_URL}/rest/v1/knowledge_items?select=id,archetypes&limit=1" \
  -H "apikey: ${SERVICE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_KEY}"
```

Expected: JSON array. Each element (if any) contains an `archetypes` field whose value is `[]`. If the request returns `column "archetypes" does not exist`, Step 2 failed — re-run it.

- [ ] **Step 4: Commit note**

No file was modified, but record the applied migration in the commit message of a later task (Task 6 covers that).

---

## Task 2: Restructure `faq-starters.js` + add pure filter

**Files:**
- Modify: `wa-studio/src/lib/faq-starters.js`
- Create: `wa-studio/tests/unit/faq-starters.test.js`

- [ ] **Step 1: Create the failing unit test**

Create `wa-studio/tests/unit/faq-starters.test.js`:
```javascript
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ARCHETYPES,
  FAQ_STARTERS_BY_CATEGORY,
  filterStartersForArchetype,
} from '../../src/lib/faq-starters.js'

test('ARCHETYPES exposes studio / service / other labels', () => {
  assert.deepEqual(Object.keys(ARCHETYPES).sort(), ['other', 'service', 'studio'])
  for (const v of Object.values(ARCHETYPES)) assert.equal(typeof v, 'string')
})

test('FAQ_STARTERS_BY_CATEGORY shape — every item has question + archetypes array', () => {
  for (const [cat, items] of Object.entries(FAQ_STARTERS_BY_CATEGORY)) {
    assert.ok(Array.isArray(items), `category ${cat} not an array`)
    for (const item of items) {
      assert.equal(typeof item.question, 'string', `${cat}: question must be string`)
      assert.ok(item.question.length > 0, `${cat}: empty question`)
      assert.ok(Array.isArray(item.archetypes), `${cat}: archetypes must be array`)
      for (const a of item.archetypes) {
        assert.ok(['studio', 'service', 'other'].includes(a), `${cat}: unknown archetype ${a}`)
      }
    }
  }
})

test('filterStartersForArchetype(studio) returns studio + universal items with category preserved', () => {
  const out = filterStartersForArchetype('studio')
  assert.ok(out.length > 0)
  for (const item of out) {
    assert.equal(typeof item.category, 'string')
    assert.equal(typeof item.question, 'string')
    assert.ok(Array.isArray(item.archetypes))
    // Each returned item is either universal (empty) or tagged with studio
    const isStudio = item.archetypes.includes('studio')
    const isUniversal = item.archetypes.length === 0
    assert.ok(isStudio || isUniversal, `unexpected archetypes for studio: ${JSON.stringify(item)}`)
  }
  // Items tagged only with 'service' are excluded
  assert.ok(!out.some(i => i.archetypes.length === 1 && i.archetypes[0] === 'service'))
})

test('filterStartersForArchetype(service) excludes studio-only items', () => {
  const out = filterStartersForArchetype('service')
  assert.ok(!out.some(i => i.archetypes.length === 1 && i.archetypes[0] === 'studio'))
  assert.ok(out.some(i => i.archetypes.length === 0), 'universal items must appear for service')
})

test('filterStartersForArchetype(other) returns only universal items', () => {
  const out = filterStartersForArchetype('other')
  for (const item of out) {
    assert.equal(item.archetypes.length, 0, `non-universal item leaked to other: ${JSON.stringify(item)}`)
  }
})

test('filterStartersForArchetype(null or unknown) returns only universal items', () => {
  const nullOut = filterStartersForArchetype(null)
  const unknownOut = filterStartersForArchetype('nonsense')
  for (const item of [...nullOut, ...unknownOut]) {
    assert.equal(item.archetypes.length, 0)
  }
})
```

- [ ] **Step 2: Run the test — expect failure**

Run:
```bash
cd wa-studio && node --test tests/unit/faq-starters.test.js
```

Expected: FAIL — tests import `ARCHETYPES` and `filterStartersForArchetype` which do not exist yet.

- [ ] **Step 3: Rewrite `src/lib/faq-starters.js`**

Overwrite the file with:
```javascript
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

export const ARCHETYPES = {
  studio:  'סטודיו',
  service: 'שירות',
  other:   'אחר',
}

export const ARCHETYPE_KEYS = Object.keys(ARCHETYPES)

export const FAQ_STARTERS_BY_CATEGORY = {
  pricing: [
    { question: 'כמה זה עולה?',                        archetypes: [] },
    { question: 'יש מנוי חודשי או כרטיסייה?',           archetypes: ['studio'] },
    { question: 'יש אפשרות לתשלומים?',                  archetypes: ['service'] },
    { question: 'יש הנחה לקבוצה / לחבר שמביא חבר?',     archetypes: ['studio'] },
  ],
  scheduling: [
    { question: 'מה שעות הפעילות?',       archetypes: [] },
    { question: 'יש שיעורים בסופ"ש?',     archetypes: ['studio'] },
    { question: 'אפשר לקבוע פגישה בערב?', archetypes: ['service'] },
  ],
  booking: [
    { question: 'מתי אפשר להתחיל?',    archetypes: [] },
    { question: 'איך נרשמים לשיעור?',  archetypes: ['studio'] },
    { question: 'איך קובעים פגישה?',   archetypes: ['service'] },
    { question: 'צריך להירשם מראש?',   archetypes: [] },
  ],
  cancellation: [
    { question: 'אפשר לבטל או לשנות פגישה?',            archetypes: ['service'] },
    { question: 'אפשר לבטל שיעור? מה מדיניות הביטולים?', archetypes: ['studio'] },
    { question: 'מה קורה אם לא הגעתי?',                  archetypes: [] },
  ],
  services: [
    { question: 'איך התהליך עובד?',          archetypes: ['service'] },
    { question: 'אילו שיעורים מוצעים?',      archetypes: ['studio'] },
    { question: 'אפשר לראות עבודות קודמות?', archetypes: ['service'] },
    { question: 'עבדתם כבר עם מקרים דומים?', archetypes: ['service'] },
  ],
  location: [
    { question: 'איפה אתם נמצאים?',            archetypes: [] },
    { question: 'יש חניה?',                    archetypes: [] },
    { question: 'יש מקלחות במקום?',            archetypes: ['studio'] },
    { question: 'אפשר להגיע בתחבורה ציבורית?', archetypes: [] },
  ],
  trial: [
    { question: 'יש שיעור ניסיון?',                  archetypes: ['studio'] },
    { question: 'אפשר שיחת היכרות לפני שמתחייבים?', archetypes: ['service'] },
    { question: 'זה מתאים גם למתחילים?',            archetypes: ['studio'] },
  ],
  general: [
    { question: 'מה צריך להביא לשיעור ראשון?', archetypes: ['studio'] },
    { question: 'כמה זמן נמשך שיעור?',         archetypes: ['studio'] },
    { question: 'כמה זמן זה לוקח?',            archetypes: ['service'] },
    { question: 'מה צריך להכין מראש?',         archetypes: ['service'] },
    { question: 'יש ליווי לאורך כל התהליך?',  archetypes: ['service'] },
  ],
}

export function filterStartersForArchetype(archetype) {
  const valid = ARCHETYPE_KEYS.includes(archetype)
  const out = []
  for (const [category, items] of Object.entries(FAQ_STARTERS_BY_CATEGORY)) {
    for (const item of items) {
      const universal = item.archetypes.length === 0
      const match = valid && item.archetypes.includes(archetype)
      if (universal || match) {
        out.push({ category, question: item.question, archetypes: item.archetypes })
      }
    }
  }
  return out
}
```

Note: the old exports `STUDIO_STARTERS`, `SERVICE_STARTERS`, `GENERIC_STARTERS`, and `FAQ_STARTERS_BY_ARCHETYPE` are **removed**. The only consumer (`supabase.js::seedFaqStarters`) is rewritten in Task 3.

- [ ] **Step 4: Run the test — expect pass**

Run:
```bash
cd wa-studio && node --test tests/unit/faq-starters.test.js
```

Expected: all 6 tests pass.

- [ ] **Step 5: Add `test:unit` npm script**

Edit `wa-studio/package.json` — replace the `scripts` block with:
```json
"scripts": {
  "dev": "vite",
  "build": "vite build",
  "preview": "vite preview",
  "test": "node tests/run.js",
  "test:unit": "node --test tests/unit/",
  "test:setup": "node tests/run.js setup",
  "test:onboarding": "node tests/run.js onboarding",
  "test:live": "node tests/run.js live"
},
```

Run `cd wa-studio && npm run test:unit`. Expected: tests pass.

- [ ] **Step 6: Commit**

```bash
git add wa-studio/src/lib/faq-starters.js wa-studio/tests/unit/faq-starters.test.js wa-studio/package.json
git commit -m "feat(faq): category-grouped starter pool with archetype tags + pure filter"
```

---

## Task 3: Rewrite FAQ functions in `supabase.js`

**Files:**
- Modify: `wa-studio/src/lib/supabase.js:2` (import line)
- Modify: `wa-studio/src/lib/supabase.js:136-144` (`loadFaqItems`)
- Modify: `wa-studio/src/lib/supabase.js:159-166` (`addFaqItem`)
- Modify: `wa-studio/src/lib/supabase.js:168-192` (`seedFaqStarters`)

- [ ] **Step 1: Update the import**

Replace line 2:
```javascript
import { FAQ_STARTERS_BY_ARCHETYPE } from './faq-starters.js'
```
with:
```javascript
import { ARCHETYPE_KEYS, filterStartersForArchetype } from './faq-starters.js'
```

- [ ] **Step 2: Update `loadFaqItems` SELECT**

Replace the body of `loadFaqItems`:
```javascript
export async function loadFaqItems(businessId) {
  const { data, error } = await supabase
    .from('knowledge_items')
    .select('id, category, question, answer, archetypes, is_active, created_at')
    .eq('business_id', businessId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data || []
}
```

- [ ] **Step 3: Update `addFaqItem` to accept archetypes**

Replace `addFaqItem`:
```javascript
export async function addFaqItem(businessId, { category, question, answer = '', archetypes = [] }) {
  const safeArchetypes = Array.isArray(archetypes)
    ? archetypes.filter(a => ARCHETYPE_KEYS.includes(a))
    : []
  const { data, error } = await supabase
    .from('knowledge_items')
    .insert({
      business_id: businessId,
      category: category || 'general',
      question,
      answer,
      archetypes: safeArchetypes,
      language: 'he',
      is_active: false,
    })
    .select().single()
  if (error) throw error
  return data
}
```

- [ ] **Step 4: Sanitize archetypes in `updateFaqItem`**

Replace `updateFaqItem`:
```javascript
export async function updateFaqItem(id, updates) {
  const clean = { ...updates }
  if ('archetypes' in clean) {
    clean.archetypes = Array.isArray(clean.archetypes)
      ? clean.archetypes.filter(a => ARCHETYPE_KEYS.includes(a))
      : []
  }
  const { error } = await supabase
    .from('knowledge_items')
    .update({ ...clean, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}
```

- [ ] **Step 5: Rewrite `seedFaqStarters`**

Replace `seedFaqStarters`:
```javascript
export async function seedFaqStarters(businessId, archetype) {
  const { count, error: countError } = await supabase
    .from('knowledge_items')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId)
  if (countError) throw countError
  if (count > 0) return

  const starters = filterStartersForArchetype(archetype)
  if (!starters.length) return

  const rows = starters.map(item => ({
    business_id: businessId,
    category: item.category,
    question: item.question,
    answer: '',
    archetypes: item.archetypes,
    language: 'he',
    is_active: false,
  }))

  const { error } = await supabase.from('knowledge_items').insert(rows)
  if (error) throw error
}
```

- [ ] **Step 6: Verify the module still loads (syntax check via Vite build)**

Run:
```bash
cd wa-studio && npm run build
```

Expected: build succeeds, no errors referencing removed `FAQ_STARTERS_BY_ARCHETYPE`.

- [ ] **Step 7: Re-run the unit test (no regression expected)**

```bash
cd wa-studio && npm run test:unit
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add wa-studio/src/lib/supabase.js
git commit -m "feat(faq): supabase functions carry archetypes; seed uses filterStartersForArchetype"
```

---

## Task 4: Archetype badges on FAQ rows (display only)

**Files:**
- Modify: `wa-studio/src/components/FaqModal.jsx:3` (import line)
- Modify: `wa-studio/src/components/FaqModal.jsx:198-214` (`FaqRow` header rendering)
- Modify: `wa-studio/src/index.css` (append new styles)

- [ ] **Step 1: Update the import in `FaqModal.jsx`**

Replace line 3:
```javascript
import { CATEGORIES } from '../lib/faq-starters.js'
```
with:
```javascript
import { CATEGORIES, ARCHETYPES, ARCHETYPE_KEYS } from '../lib/faq-starters.js'
```

- [ ] **Step 2: Render archetype pills in `FaqRow`**

In `FaqRow`, replace the existing row header block (roughly lines 204-214) with:
```jsx
  const catLabel = CATEGORIES[item.category] || item.category
  const archetypes = Array.isArray(item.archetypes) ? item.archetypes : []
  const archetypePills = archetypes.length === 0
    ? [{ key: 'universal', label: 'כללי', cls: 'fq-arc-universal' }]
    : archetypes
        .filter(a => ARCHETYPE_KEYS.includes(a))
        .map(a => ({ key: a, label: ARCHETYPES[a], cls: `fq-arc-${a}` }))

  return (
    <div className={`fq-row fq-row-${status}`}>
      <div className="fq-row-hd" onClick={onToggle}>
        <span className="fq-chevron">{expanded ? '▾' : '▸'}</span>
        <span className="fq-cat-badge" lang="he">{catLabel}</span>
        {archetypePills.map(p => (
          <span key={p.key} className={`fq-arc-badge ${p.cls}`} lang="he">{p.label}</span>
        ))}
        <span className="fq-q-text" lang="he" dir="rtl">{item.question || '(שאלה ריקה)'}</span>
        <span className={`fq-status-badge ${st.cls}`} lang="he">{st.label}</span>
        <span className="fq-row-btns" onClick={e => e.stopPropagation()}>
          <button className="fq-icon-btn" onClick={onEdit} title="ערוך">✏️</button>
          <button className="fq-icon-btn" onClick={onDelete} title="מחק">🗑️</button>
        </span>
      </div>
```

(Leave the rest of `FaqRow` — the `{expanded && (...)}` block and the closing `</div>` — unchanged. Only the header JSX and the two new derived variables are new.)

- [ ] **Step 3: Append CSS for archetype badges**

Append to the end of `wa-studio/src/index.css`:
```css
/* FAQ archetype badges */
.fq-arc-badge {
  font-size: 10px; padding: 2px 8px; border-radius: 10px; flex-shrink: 0;
  font-family: 'Segoe UI', 'Arial Unicode MS', system-ui, sans-serif;
  border: 1px solid transparent;
}
.fq-arc-universal { background: rgba(255,255,255,0.06); color: var(--text-dim); }
.fq-arc-studio    { background: rgba(0,170,180,0.15);  color: #00bcd4; }
.fq-arc-service   { background: rgba(255,170,0,0.15);  color: #ffb000; }
.fq-arc-other     { background: rgba(180,120,255,0.15); color: #b478ff; }
```

- [ ] **Step 4: Manual browser smoke (5 minutes)**

Start the dev server and open the FAQ panel for an existing business:
```bash
cd wa-studio && npm run dev
```

Expected: each row shows category pill + at least one archetype pill (`כללי` for any untagged historical row). No console errors. Colors readable in both light and dark states of the app.

Stop the dev server (Ctrl+C) when done.

- [ ] **Step 5: Commit**

```bash
git add wa-studio/src/components/FaqModal.jsx wa-studio/src/index.css
git commit -m "feat(faq): render archetype badges on each knowledge-base row"
```

---

## Task 5: Archetype multi-select in edit + add forms

**Files:**
- Modify: `wa-studio/src/components/FaqModal.jsx` — `FaqPanel` default state (line ~28), `handleAdd`, `startEdit`, and both JSX forms
- Modify: `wa-studio/src/index.css` — `.fq-arc-checkboxes`

- [ ] **Step 1: Seed `archetypes` in the new-item state**

In `FaqPanel`, change the `newItem` initial state (currently `useState({ category: 'general', question: '', answer: '' })`) to:
```javascript
  const [newItem, setNewItem] = useState({ category: 'general', question: '', answer: '', archetypes: [] })
```

Also update the reset inside `handleAdd` (after a successful add) and the cancel button's reset so both use `{ category: 'general', question: '', answer: '', archetypes: [] }`.

- [ ] **Step 2: Seed `archetypes` in `startEdit`**

Change `startEdit` so the per-item edit state carries archetypes:
```javascript
  function startEdit(item) {
    setEditState(prev => ({
      ...prev,
      [item.id]: {
        question: item.question,
        answer: item.answer,
        category: item.category || 'general',
        archetypes: Array.isArray(item.archetypes) ? [...item.archetypes] : [],
      },
    }))
    setExpandedId(item.id)
  }
```

- [ ] **Step 3: Pass `archetypes` through `saveEdit`**

Change the `updateFaqItem` call inside `saveEdit` to include archetypes:
```javascript
      await updateFaqItem(item.id, {
        question: edit.question,
        answer: edit.answer,
        category: edit.category,
        archetypes: edit.archetypes,
      })
```

- [ ] **Step 4: Add a reusable checkbox helper inside the component file**

Add this small presentation component ABOVE `FaqPanel` (top of `FaqModal.jsx`, after imports):
```jsx
function ArchetypeCheckboxes({ value, onChange }) {
  const current = Array.isArray(value) ? value : []
  function toggle(key) {
    onChange(current.includes(key) ? current.filter(k => k !== key) : [...current, key])
  }
  return (
    <div className="fq-arc-checkboxes" lang="he">
      <span className="fq-arc-cb-label">ארכיטיפ:</span>
      {ARCHETYPE_KEYS.map(k => (
        <label key={k} className="fq-arc-cb">
          <input
            type="checkbox"
            checked={current.includes(k)}
            onChange={() => toggle(k)}
          />
          <span>{ARCHETYPES[k]}</span>
        </label>
      ))}
      <span className="fq-arc-cb-hint">(ללא סימון = כללי)</span>
    </div>
  )
}
```

- [ ] **Step 5: Mount the checkboxes inside the add-new form**

In the `{addOpen && (...)}` block, insert the helper between the category select and the question input:
```jsx
            <ArchetypeCheckboxes
              value={newItem.archetypes}
              onChange={ar => setNewItem(p => ({ ...p, archetypes: ar }))}
            />
```

- [ ] **Step 6: Mount the checkboxes inside the edit form**

In `FaqRow`, inside the `{editing ? (...)}` branch, add the helper just below the category `<select>`:
```jsx
              <ArchetypeCheckboxes
                value={editing.archetypes}
                onChange={ar => onEditChange({ archetypes: ar })}
              />
```

Because `ArchetypeCheckboxes` is defined in the same module (Step 4), it's in scope for `FaqRow`.

- [ ] **Step 7: Append CSS for the checkbox group**

Append to `wa-studio/src/index.css`:
```css
.fq-arc-checkboxes {
  display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
  padding: 6px 0; font-size: 13px; color: var(--text-dim);
  direction: rtl;
}
.fq-arc-cb-label { font-weight: 500; color: var(--text-default); }
.fq-arc-cb { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.fq-arc-cb input[type=checkbox] { cursor: pointer; }
.fq-arc-cb-hint { font-size: 11px; color: var(--text-muted); }
```

- [ ] **Step 8: Manual smoke — edit + add**

Start the dev server:
```bash
cd wa-studio && npm run dev
```

Then in the browser:
1. Open FAQ panel for any business.
2. Edit one existing row → toggle a couple of archetype checkboxes → save.
3. Collapse and re-open the panel — confirm the new badges reflect the edit.
4. Click `+ שאלה חדשה` → fill a question → check one archetype → save.
5. Confirm the new row appears with that archetype badge.

Ctrl+C to stop the dev server.

- [ ] **Step 9: Commit**

```bash
git add wa-studio/src/components/FaqModal.jsx wa-studio/src/index.css
git commit -m "feat(faq): archetype multi-select in add + edit forms"
```

---

## Task 6: Regression + memory update

**Files:**
- Modify (memory): `C:\Users\Diva\.claude\projects\C--Users-Diva-Documents-Web-Projects-AI-Playground-Multi-agent\memory\project_wa_sales_agent.md`

- [ ] **Step 1: Run the full unit suite**

```bash
cd wa-studio && npm run test:unit
```
Expected: PASS.

- [ ] **Step 2: Run the integration harness (baseline must stay 7/7)**

Only run if an n8n instance + Supabase are reachable from this machine. If either is down, skip to Step 3 and note it in the commit body.

```bash
cd wa-studio && npm test
```
Expected: `7/7 passed`. If anything is red, stop and investigate — the archetype change should be orthogonal to every existing scenario.

- [ ] **Step 3: Update memory — mark FAQ archetype tagging shipped**

Edit the "Still pending" section of `project_wa_sales_agent.md` — remove the FAQ-related items if present (encoding + redesign were already done; nothing new to remove here) and add one line under the existing "Bugs fixed / features shipped" block:
```
- FAQ archetype tagging shipped 2026-04-20: archetypes TEXT[] column on knowledge_items; starter pool restructured category-grouped with per-question archetype tags; admin UI shows badges + checkbox editor.
```

- [ ] **Step 4: Final commit**

```bash
git add "C:/Users/Diva/.claude/projects/C--Users-Diva-Documents-Web-Projects-AI-Playground-Multi-agent/memory/project_wa_sales_agent.md"
git commit -m "chore: memory — FAQ archetype tagging shipped"
```

(If git refuses the memory path because it lives outside this repo, skip the commit — memory lives in the user's profile and doesn't belong to the repo. Just save the file.)

---

## Notes for the executing engineer

- **Hebrew in source files is fine** — the repo already uses Hebrew literals in other files (memory line: "FAQ full-screen panel + Hebrew encoding fix" was merged). No `\uXXXX` escaping needed.
- **No CHECK constraint on `archetypes`** is intentional — validation is client-side so the vocabulary can evolve without schema migrations.
- **`FaqModal.jsx` is a panel, not a modal** — filename is historical. Don't rename it; the file is imported by string elsewhere and the rename would multiply the diff.
- **Backfill is a no-op** — existing rows land on `'{}'` (universal) via the column default and render with a `כללי` pill. The user will curate them via the UI.
- **Don't try to keep the old `FAQ_STARTERS_BY_ARCHETYPE` alive** — `supabase.js` is the only consumer and Task 3 removes the last reference.

## Execution Handoff

Plan complete and saved to `wa-studio/docs/superpowers/plans/2026-04-20-faq-archetype-tagging.md`.
