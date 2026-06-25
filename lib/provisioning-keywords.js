// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
//
// Claude-driven local SEO keyword generator. Used by the
// provisioning agent to seed 3 keywords on every new tenant. Falls
// back to a sensible default list when ANTHROPIC_API_KEY isn't
// configured so provisioning never blocks on the AI step.

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

// Strip JSON out of Claude's response. The prompt asks for a bare
// array but models sometimes wrap it in prose ("Here are…") or a
// code fence — accept either shape.
function extractKeywordArray(text) {
  if (!text) return [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : text;
  const arrMatch = candidate.match(/\[[\s\S]*?\]/);
  if (!arrMatch) return [];
  try {
    const parsed = JSON.parse(arrMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(x => String(x).trim()).filter(Boolean);
  } catch { return []; }
}

// Default keywords when Claude isn't configured. Returns 3 generic
// local SEO patterns wrapped around the business name so the seed
// table is never empty.
function fallbackKeywords({ businessName, city, state }) {
  const loc = [city, state].filter(Boolean).join(' ');
  const tail = loc ? ` ${loc}` : '';
  return [
    `${businessName}${tail}`,
    `best${tail ? ' ' : ''}${loc} salon`,
    `book appointment${tail}`
  ].slice(0, 3);
}

export async function generateLocalSeoKeywords({ businessName, city, state, services = [] }) {
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) {
    console.log('[provisioning-keywords] ANTHROPIC_API_KEY not set, using fallback');
    return fallbackKeywords({ businessName, city, state });
  }

  const serviceLine = Array.isArray(services) && services.length
    ? `\nServices offered: ${services.slice(0, 6).map(s => typeof s === 'string' ? s : (s.name || '')).filter(Boolean).join(', ')}`
    : '';
  const locLine = [city, state].filter(Boolean).join(', ');

  const prompt =
    `Generate 3 high-value local SEO keywords for a business named "${businessName}"` +
    (locLine ? ` in ${locLine}.` : '.') +
    serviceLine +
    `\n\nReturn ONLY a JSON array of 3 keyword strings. No prose, no markdown, no commentary. Example: ["keyword one", "keyword two", "keyword three"]`;

  try {
    const res = await fetch(CLAUDE_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn('[provisioning-keywords] Claude API non-2xx:', res.status, text.slice(0, 200));
      return fallbackKeywords({ businessName, city, state });
    }
    const data = await res.json();
    const text = data?.content?.[0]?.text || '';
    const arr = extractKeywordArray(text);
    if (!arr.length) return fallbackKeywords({ businessName, city, state });
    return arr.slice(0, 3);
  } catch (err) {
    console.warn('[provisioning-keywords] Claude API threw:', err?.message || err);
    return fallbackKeywords({ businessName, city, state });
  }
}
