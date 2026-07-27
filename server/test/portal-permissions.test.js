import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_SETTINGS_COLUMNS, FULL_EDIT_COLUMNS, settingsColumnsFor, pickSettings,
} from '../lib/portal-permissions.js';

test('a normal client may only touch the operational settings', () => {
  const cols = settingsColumnsFor(false);
  assert.deepEqual(cols, BASE_SETTINGS_COLUMNS);
  assert.ok(!cols.includes('guardrails'), 'policy stays admin-only by default');
  assert.ok(!cols.includes('agent_mode'));
});

test('a full-edit business also exposes policy, persona, goal and push style', () => {
  const cols = settingsColumnsFor(true);
  for (const k of FULL_EDIT_COLUMNS) assert.ok(cols.includes(k), `${k} should be editable`);
  for (const k of BASE_SETTINGS_COLUMNS) assert.ok(cols.includes(k), `${k} should still be editable`);
});

test('policy edits are dropped when the business is not in full-edit mode', () => {
  // The whole point of the flag: the same request body must be harmless against
  // a normal client's business.
  const clean = pickSettings(
    { working_hours: { sun: [] }, guardrails: { forbidden_topics: [] }, agent_mode: 'sales' },
    settingsColumnsFor(false),
  );
  assert.deepEqual(Object.keys(clean), ['working_hours']);
});

test('policy edits go through when the business is in full-edit mode', () => {
  const clean = pickSettings(
    { guardrails: { forbidden_topics: ['prices'] }, agent_mode: 'sales' },
    settingsColumnsFor(true),
  );
  assert.deepEqual(clean.guardrails, { forbidden_topics: ['prices'] });
  assert.equal(clean.agent_mode, 'sales');
});

test('unknown keys are stripped in both modes', () => {
  for (const full of [false, true]) {
    const clean = pickSettings(
      { business_id: 'other-business', id: 1, whatsapp_number: '972500000000' },
      settingsColumnsFor(full),
    );
    assert.deepEqual(clean, {}, `nothing should pass in full=${full}`);
  }
});

test('a client can never grant themselves full-edit', () => {
  // The flag lives on `businesses`; the portal writes `business_profiles`. Even
  // so, assert it explicitly — this is the escalation path worth pinning.
  for (const full of [false, true]) {
    const clean = pickSettings({ portal_full_edit: true }, settingsColumnsFor(full));
    assert.deepEqual(clean, {});
  }
});

test('a key present but undefined is not written', () => {
  const clean = pickSettings({ working_hours: undefined }, settingsColumnsFor(false));
  assert.deepEqual(clean, {});
});

test('null is a legitimate value and survives', () => {
  const clean = pickSettings({ after_hours_message: null }, settingsColumnsFor(false));
  assert.deepEqual(clean, { after_hours_message: null });
});
