// Which business an inbound message belongs to.
//
// The receiving WhatsApp number is the authority: it is what the sender
// actually contacted. A session row only records where that number pointed the
// last time this person wrote, which goes stale the moment a number is moved to
// a different business.
//
// Before this, the session won unconditionally and only brand-new senders were
// resolved from the number — so every contact who had ever messaged before a
// re-point stayed bound to the old business forever, silently. Observed live:
// a session created 2026-06-21 kept routing to a test business with zero active
// knowledge, three days after the number was connected to the real one.

/**
 * @param {string|null} sessionBusinessId    business recorded on the session
 * @param {string|null} businessIdFromNumber business owning the receiving number
 * @returns {{businessId: string|null, corrected: boolean}}
 */
export function resolveSessionBusiness({ sessionBusinessId, businessIdFromNumber }) {
  // No signal from the number (Studio console, scripted tests, missing pnid):
  // keep whatever the session says rather than blanking a working conversation.
  if (!businessIdFromNumber) {
    return { businessId: sessionBusinessId ?? null, corrected: false };
  }
  if (sessionBusinessId === businessIdFromNumber) {
    return { businessId: businessIdFromNumber, corrected: false };
  }
  return { businessId: businessIdFromNumber, corrected: true };
}
