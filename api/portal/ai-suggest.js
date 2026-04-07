import { requireUser, methodGuard, readJson } from '../../lib/auth.js';

// Generate 3 short SMS reply suggestions using Claude.
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { sb, clientId } = ctx;
  const { contact_id } = await readJson(req);
  if (!contact_id) return res.status(400).json({ error: 'contact_id_required' });

  const { data: contact } = await sb.from('contacts').select('name').eq('id', contact_id).single();
  const { data: thread } = await sb
    .from('messages')
    .select('direction, body, created_at')
    .eq('contact_id', contact_id)
    .order('created_at', { ascending: false })
    .limit(10);

  const transcript = (thread || []).reverse()
    .map(m => `${m.direction === 'inbound' ? 'Customer' : 'Business'}: ${m.body}`)
    .join('\n');

  if (!process.env.ANTHROPIC_API_KEY) {
    // Fallback canned suggestions if no API key
    return res.status(200).json({
      suggestions: [
        "Thanks for reaching out! How can I help?",
        "Got it — what time works best for you?",
        "Appreciate the message! I'll get back to you shortly."
      ]
    });
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: `You are drafting SMS reply options for a small business owner replying to a customer named ${contact?.name || 'Customer'}. Based on the conversation below, generate exactly 3 short, friendly, professional reply options. Each must be under 160 characters. Return ONLY a JSON array of 3 strings, no other text.\n\nConversation:\n${transcript || '(no prior messages)'}`
        }]
      })
    });
    const data = await r.json();
    const text = data?.content?.[0]?.text || '[]';
    const match = text.match(/\[[\s\S]*\]/);
    const suggestions = match ? JSON.parse(match[0]) : [];
    return res.status(200).json({ suggestions: suggestions.slice(0, 3) });
  } catch (e) {
    return res.status(200).json({ suggestions: [] });
  }
}
