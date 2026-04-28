// Forgiving merge-tag renderer for SMS templates that non-technical
// users edit. Accepts variants like [first name], [first_name], [First
// Name], {first_name}, {{first_name}} — all map to the same lookup.

export function firstName(full) {
  if (!full) return '';
  return String(full).trim().split(/\s+/)[0] || '';
}

const BRACKET_RE = /\[\s*([a-zA-Z][a-zA-Z0-9_ ]{0,30}?)\s*\]/g;
const BRACE_RE   = /\{\{?\s*([a-zA-Z][a-zA-Z0-9_ ]{0,30}?)\s*\}\}?/g;

function normalizeKey(k) {
  return String(k).toLowerCase().trim().replace(/\s+/g, '_');
}

// Returns rendered template with merge tags replaced. Unknown tags are
// left in place (so the user notices "[brand]" wasn't substituted, vs
// silently dropping it).
export function renderTemplate(template, vars) {
  if (!template) return '';
  const lookup = {};
  for (const k of Object.keys(vars || {})) lookup[normalizeKey(k)] = vars[k];
  if (vars && vars.name && lookup.first_name === undefined) {
    lookup.first_name = firstName(vars.name);
  }
  const sub = (m, k) => {
    const key = normalizeKey(k);
    const v = lookup[key];
    return v !== undefined && v !== null ? String(v) : m;
  };
  return String(template).replace(BRACKET_RE, sub).replace(BRACE_RE, sub);
}
