// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
//
// Supabase Edge Function: submit-application
//
// Public, unauthenticated POST endpoint that accepts an artist
// application from a tenant's marketing site (e.g. iSlay Studios'
// public apply form) and inserts it into public.applications using
// the service role key. The fields are whitelisted on the way in so
// the form can't spoof status, notes, created_at, or id.
//
// Deploy:
//   supabase functions deploy submit-application --project-ref bnkoqybkmwtrlorhowyv
//
// Invoke (public):
//   POST https://bnkoqybkmwtrlorhowyv.functions.supabase.co/submit-application
//   Content-Type: application/json
//   Body:
//     { "client_id": "islay_studios",
//       "full_name": "Jordan Lee",
//       "email": "jordan@example.com",
//       "phone": "+15555550123",
//       "specialty": ["Barber", "Braids & Locs"],
//       ... }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const jsonResponse = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' }
  });

// deno-lint-ignore no-explicit-any
const asStr = (v: any): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' });

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); }
  catch { return jsonResponse(400, { error: 'invalid_json' }); }

  const client_id = asStr(body?.client_id);
  const email     = asStr(body?.email);
  if (!client_id) return jsonResponse(400, { error: 'client_id is required' });
  if (!email)     return jsonResponse(400, { error: 'email is required' });

  const supabaseUrl  = Deno.env.get('SUPABASE_URL');
  const serviceKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return jsonResponse(500, { error: 'server_misconfigured' });

  const sb = createClient(supabaseUrl, serviceKey);

  // Whitelist exactly the fields the public form is allowed to set.
  // status / notes are operator-only and stay at their column defaults
  // (status='new', notes=NULL). id, created_at, and any future
  // operator-only fields are likewise untouched.
  const insert: Record<string, unknown> = {
    client_id,
    full_name:         asStr(body?.full_name),
    phone:             asStr(body?.phone),
    email,
    instagram:         asStr(body?.instagram),
    city_state:        asStr(body?.city_state),
    specialty:         Array.isArray(body?.specialty)
                         ? body.specialty.filter((v: unknown) => typeof v === 'string' && v.trim()).map((v: string) => v.trim())
                         : null,
    years_experience:  asStr(body?.years_experience),
    employment_status: asStr(body?.employment_status),
    has_clientele:     typeof body?.has_clientele === 'boolean' ? body.has_clientele : null,
    clientele_count:   asStr(body?.clientele_count),
    bio:               asStr(body?.bio),
    portfolio_url:     asStr(body?.portfolio_url),
    desired_start:     asStr(body?.desired_start),
    booth_preference:  asStr(body?.booth_preference),
    schedule:          asStr(body?.schedule),
    referral_source:   asStr(body?.referral_source)
  };

  const { data, error } = await sb.from('applications').insert(insert).select('id').single();
  if (error) return jsonResponse(500, { error: error.message });
  return jsonResponse(200, { ok: true, id: data?.id });
});
