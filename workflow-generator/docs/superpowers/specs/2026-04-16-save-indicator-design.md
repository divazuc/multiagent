# Save Indicator — Design Spec
_2026-04-16_

## Problem

The project flow (steps 1–4 in `ProjectMode`) already auto-saves draft state to localStorage every second (debounced), but the user has no visibility into this. There is no "saved" confirmation, no timestamp, and no way to manually trigger a save. Users assume their progress is lost if they close the tab.

## Scope

Client-only change. No server routes, no new files. All work is in:
- `workflow-generator/client/src/components/ProjectMode.jsx`

## Design

### 1. State additions

Add one new piece of state:

```js
const [lastSavedAt, setLastSavedAt] = useState(null)
```

`null` means no save has fired yet in this session.

### 2. Save logic changes

**Existing auto-save `useEffect`** — add one line to record when the save fires:

```js
saveDraft(slug, { ... })
setLastSavedAt(new Date())
```

**New `handleSave` function** — manual immediate save, bypasses the 1s debounce:

```js
function handleSave() {
  saveDraft(slug, { step, spec, slug, clarifications, currentClarification, optionalAnswers, pendingInfo, workflowMap, generated })
  setLastSavedAt(new Date())
}
```

**Refresh interval** — keeps the "X ago" text live without re-saving. A single stable interval increments a tick counter; the display reads `lastSavedAt` directly:

```js
const [, setTick] = useState(0)
useEffect(() => {
  const id = setInterval(() => setTick(t => t + 1), 30000)
  return () => clearInterval(id)
}, [])
```

### 3. UI — save strip in step header row

The existing step breadcrumb row becomes a space-between flex row. A save strip is added on the right.

**Visibility rule:** only render when `slug` is set AND `step !== 'spec'`. On step 1 the user hasn't committed to a named session, so nothing to show.

**Save strip layout:**

```
[ Saved 2m ago ]  [ Save ]
```

- Timestamp label:
  - `lastSavedAt` is null → amber "Unsaved" label
  - Otherwise → `text-xs text-slate-400` showing `relativeTime(lastSavedAt)`
- Save button: `border border-slate-200 text-slate-500 text-xs px-2 py-1 rounded hover:border-indigo-400 hover:text-indigo-600`
- On click: button shows "Saved ✓" in `text-green-600` for 1.5s, then reverts to "Save"

### 4. Confirmed non-changes

- No navigation away on save (user stays on current step)
- No new files
- No server routes
- Draft delete-on-import behaviour unchanged
- Resume list on step 1 unchanged

## Behaviour summary

| Situation | What user sees |
|---|---|
| Step 1 (no slug set) | Nothing — save strip hidden |
| Steps 2–4, not yet auto-saved | "Unsaved" in amber |
| Steps 2–4, auto-save has fired | "Saved 2m ago" (updates every 30s) |
| User clicks Save | Button flashes "Saved ✓" for 1.5s |
| User closes and reopens | Draft resume list on step 1 as before |
