//
// Bot/domain classification shared by the overview stats and (mirrored
// client-side in wa-studio/src/demo/bots.js) the dashboard filters. A "bots"
// config array lives in business_profiles.draft_setup_data.dashboard_config;
// keywords are regex sources, and the single bot with keywords === null is
// the default bucket for anything that matches nothing.

export function buildBotTests(bots) {
  if (!Array.isArray(bots)) return null;
  const tests = [];
  for (const b of bots) {
    if (!b?.id || !b.keywords) continue;
    try {
      tests.push({ id: b.id, re: new RegExp(b.keywords, 'i') });
    } catch { /* an invalid pattern must not take the dashboard down */ }
  }
  return tests.length ? tests : null;
}

export function defaultBotId(bots) {
  if (!Array.isArray(bots) || !bots.length) return null;
  return (bots.find(b => b && b.keywords == null) ?? bots[0]).id ?? null;
}

export function classifyText(text, bots) {
  if (!Array.isArray(bots) || !bots.length) return null;
  const tests = buildBotTests(bots);
  if (!tests) return defaultBotId(bots);
  const hit = tests.find(t => t.re.test(text ?? ''));
  return hit ? hit.id : defaultBotId(bots);
}
