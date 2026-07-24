// The structured-action protocol: the model REQUESTS an action inside its
// reply; the server strips the marker and decides whether to execute.
const MARKER_RE = /<<ACTION:([a-z_]+)\.([a-z_]+)(\{[\s\S]*?\})>>/g;

export function extractModuleAction(text) {
  let action = null;
  const stripped = String(text ?? '').replace(MARKER_RE, (_m, mod, name, json) => {
    if (!action) {
      try { action = { module: mod, name, payload: JSON.parse(json) }; } catch { /* malformed — strip anyway */ }
    }
    return '';
  }).replace(/[ \t]+\n/g, '\n').trim();
  return { text: stripped, action };
}
