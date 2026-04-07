// Supabase Edge Function — deploy this in THE-AI-EXIT-STRATEGY project
// (NOT in the GoElev8.AI project). It receives Supabase Database Webhook
// payloads, normalizes them, HMAC-signs, and forwards to the GoElev8.AI
// portal ingest endpoint.
//
// Deploy:
//   supabase functions deploy forward-to-goelev8 --project-ref <ai-exit-strategy-ref>
//
// Set secrets (in The-AI-Exit-Strategy project):
//   supabase secrets set INGEST_WEBHOOK_SECRET=<same value as in Vercel> \
//                       GOELEV8_INGEST_URL=https://portal.goelev8.ai/api/events?action=ingest \
//                       --project-ref <ai-exit-strategy-ref>
//
// Wire a Database Webhook (Supabase dashboard → Database → Webhooks):
//   Table:   <e.g. flex_fit_signups>
//   Events:  Insert (and Update, if you want)
//   Type:    Supabase Edge Function
//   Function: forward-to-goelev8
//   HTTP Params (query string), pick what applies per table:
//     client_slug = flex-facility            (REQUIRED — which portal client to attribute)
//     event_type  = form_submission          (REQUIRED — label shown in Activity feed)
//     source      = theflexfacility.com      (REQUIRED — public host the data came from)
//     source_path = /fit                     (optional — sub-path/funnel)
//     id_field    = id                       (optional — column used as external_id, default "id")
//     email_field = email                    (optional)
//     phone_field = phone                    (optional)
//     name_field  = name                     (optional, also tries first_name+last_name)
//     title       = New /fit signup          (optional, static label)
//
// You point one Edge Function at MANY Database Webhooks; the query string
// tells the function which client/source/type each row belongs to. The two
// Supabase projects stay isolated — this function only POSTs outward over
// HTTPS, never reads anything from GoElev8.AI.

// deno-lint-ignore-file no-explicit-any
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const SECRET    = Deno.env.get('INGEST_WEBHOOK_SECRET') ?? '';
const TARGET    = Deno.env.get('GOELEV8_INGEST_URL') ??
                  'https://portal.goelev8.ai/api/events?action=ingest';

function pick(row: Record<string, any>, key: string | null): any {
  if (!key) return null;
  return row?.[key] ?? null;
}

function fullName(row: Record<string, any>, key: string | null): string | null {
  const direct = pick(row, key);
  if (direct) return String(direct);
  const fn = row?.first_name ?? row?.firstName;
  const ln = row?.last_name  ?? row?.lastName;
  if (fn || ln) return [fn, ln].filter(Boolean).join(' ');
  return null;
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('method_not_allowed', { status: 405 });
  }
  if (!SECRET) {
    return new Response('missing_INGEST_WEBHOOK_SECRET', { status: 500 });
  }

  // Query-string config tells us how to interpret the row.
  const url = new URL(req.url);
  const q   = url.searchParams;
  const client_slug = q.get('client_slug');
  const event_type  = q.get('event_type') ?? 'form_submission';
  const source      = q.get('source');
  const source_path = q.get('source_path');
  const id_field    = q.get('id_field')    ?? 'id';
  const email_field = q.get('email_field') ?? 'email';
  const phone_field = q.get('phone_field') ?? 'phone';
  const name_field  = q.get('name_field')  ?? 'name';
  const title       = q.get('title');

  if (!client_slug || !source) {
    return new Response('missing client_slug or source query param', { status: 400 });
  }

  let hook: any;
  try { hook = await req.json(); }
  catch { return new Response('invalid_json', { status: 400 }); }

  // Supabase DB webhook payload shape:
  // { type: 'INSERT'|'UPDATE'|'DELETE', table, schema, record, old_record }
  const row: Record<string, any> = hook?.record ?? hook ?? {};

  const body = JSON.stringify({
    client_slug,
    source,
    source_path: source_path ?? null,
    event_type,
    external_id: pick(row, id_field) != null ? String(pick(row, id_field)) : null,
    contact_email: pick(row, email_field),
    contact_phone: pick(row, phone_field),
    contact_name:  fullName(row, name_field),
    title: title ?? null,
    payload: row,
    occurred_at: row?.created_at ?? row?.inserted_at ?? new Date().toISOString()
  });

  const sig = 'sha256=' + await hmacHex(SECRET, body);

  const r = await fetch(TARGET, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goelev8-signature': sig
    },
    body
  });

  const text = await r.text();
  return new Response(text, {
    status: r.status,
    headers: { 'content-type': r.headers.get('content-type') ?? 'text/plain' }
  });
});
