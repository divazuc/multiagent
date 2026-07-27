// What a client may change about their own bot, from the portal.
//
// By default the bot POLICY is admin-only: conversation flow must not change
// without the operator knowing. A business flagged `portal_full_edit` opts out
// of that — used for evaluation accounts where a prospect is deliberately
// invited to break things.
//
// The flag lives on `businesses`, never on `business_profiles`, so it can never
// be reached by the very write path it governs.

export const BASE_SETTINGS_COLUMNS = [
  'agent_active', 'answer_after_hours', 'working_hours', 'after_hours_message',
  'followup_enabled', 'followup_delay_days', 'followup_message',
];

// Policy, identity, and what the bot drives toward.
export const FULL_EDIT_COLUMNS = [
  'guardrails', 'persona', 'agent_mode', 'cta_goal', 'push_speed',
];

export function settingsColumnsFor(fullEdit) {
  return fullEdit ? [...BASE_SETTINGS_COLUMNS, ...FULL_EDIT_COLUMNS] : [...BASE_SETTINGS_COLUMNS];
}

export function pickSettings(updates, columns) {
  const clean = {};
  for (const k of columns) {
    if (k in (updates ?? {}) && updates[k] !== undefined) clean[k] = updates[k];
  }
  return clean;
}
