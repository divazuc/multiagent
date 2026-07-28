// Orchestrates one "שמירת מדיניות" click in BotPolicyEditor.jsx: post the
// merged business_profiles updates (persona/guardrails/working_hours/nudge
// cadence — one request, they're all columns on the same row), then flush
// both contacts through their own dedicated op.
//
// Pure and DOM-free on purpose (see task-9-report.md, fix round 1): asserting
// this ordering against the real React component would need a DOM test
// harness this repo doesn't have and isn't adding. Every step here is
// awaited in sequence and a failure anywhere propagates to the caller rather
// than being swallowed — that is the fix for two review findings: a failed
// nudge-cadence save silently reporting success, and contact edits typed
// into the form being discarded when the operator uses this button instead
// of the per-contact "שמירת איש קשר" button.
export async function saveBotPolicy({ businessId, updates, contacts, postUpdate, postContact }) {
  await postUpdate(businessId, updates)
  for (const [role, fields] of Object.entries(contacts ?? {})) {
    try {
      await postContact(businessId, role, fields)
    } catch (e) {
      const tagged = new Error(e.message)
      tagged.role = role
      throw tagged
    }
  }
}
