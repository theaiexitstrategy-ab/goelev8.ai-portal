// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
// Lead dedupe helper.
//
// Same person submitting on theflexfacility.com AND book.theflexfacility.com
// would create two leads pointing at the same human, inflating lead-count
// metrics and triggering the nudge drip twice. This helper finds the
// canonical lead by (client_id, normalized_phone) — falling back to
// (client_id, lower(email)) — and either updates it in place or creates
// a fresh row when no match exists.
//
// Returns { id, created } so the caller can decide whether to fire the
// "first time" notifications (push, nudge enrollment) or stay silent.
//
// Tolerant of missing columns (paid_at, tags) so it works on schemas
// that haven't run migration 0023.

import { supabaseAdmin } from './supabase.js';
import { toE164 } from './phone.js';

// 90 days is long enough to catch a prospect who came back to the
// funnel weeks later, short enough that a phone-number reassignment
// (rare but happens with cell carriers) doesn't merge unrelated humans.
const LOOKBACK_DAYS = 90;

// Family-share guard: a household can share one phone or one email
// across multiple humans (siblings, parent + kid). Without this guard,
// "Levi Harris" and "Legend Harris" submitting from the same phone
// number would collapse into one lead. We require either matching
// first names OR a blank name on one side to merge.
function firstNameKey(name) {
  if (!name) return '';
  return String(name).trim().toLowerCase().split(/\s+/)[0];
}
function sameHumanByName(a, b) {
  const fa = firstNameKey(a);
  const fb = firstNameKey(b);
  if (!fa || !fb) return true; // one side missing → safe to merge (fill in later)
  return fa === fb;
}

function mergeNonNull(existing, incoming) {
  // Only overwrite fields that are blank on the existing row. Preserve
  // human-edited values (notes, intent, status) once they're set.
  const out = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined || v === null || v === '') continue;
    if (existing[k] === undefined || existing[k] === null || existing[k] === '') out[k] = v;
  }
  return out;
}

export async function findOrUpsertLead(clientId, payload) {
  const phoneE164 = toE164(payload.phone) || null;
  const emailLower = payload.email ? String(payload.email).trim().toLowerCase() : null;

  let existing = null;
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400 * 1000).toISOString();

  // Phone is the strongest signal — but a household can share one phone,
  // so we still require the first-name match (or an unnamed side) before
  // we consider this the same human.
  if (phoneE164) {
    const orig = String(payload.phone || '').replace(/\s+/g, '');
    const candidates = [phoneE164];
    if (orig && orig !== phoneE164) candidates.push(orig);
    const { data } = await supabaseAdmin
      .from('leads').select('*')
      .eq('client_id', clientId)
      .in('phone', candidates)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(10);
    existing = (data || []).find(l => sameHumanByName(l.name, payload.name)) || null;
  }
  // Fall back to email if no phone match (or no phone provided). Same
  // family-share guard applies — a parent + kid can share an email.
  if (!existing && emailLower) {
    const { data } = await supabaseAdmin
      .from('leads').select('*')
      .eq('client_id', clientId)
      .ilike('email', emailLower)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(10);
    existing = (data || []).find(l => sameHumanByName(l.name, payload.name)) || null;
  }

  if (existing) {
    // Merge: fill blanks, append new tags, normalize phone to E.164.
    const patch = mergeNonNull(existing, {
      name:   payload.name || null,
      phone:  phoneE164 || payload.phone || null,
      email:  payload.email || null,
      source: payload.source || null,
      funnel: payload.funnel || null,
      intent: payload.intent || null,
      notes:  payload.notes || null
    });
    // Tags: union — never lose tags an operator already applied.
    if (Array.isArray(payload.tags) && payload.tags.length) {
      const existingTags = Array.isArray(existing.tags) ? existing.tags : [];
      patch.tags = [...new Set([...existingTags, ...payload.tags])];
    }
    if (Object.keys(patch).length) {
      await supabaseAdmin.from('leads').update(patch).eq('id', existing.id);
    }
    return { id: existing.id, created: false };
  }

  // No match — insert a new lead. Falls back to a leaner column set if
  // the schema is missing 'tags' or 'funnel'.
  const insertRow = {
    client_id: clientId,
    name:   payload.name || null,
    phone:  phoneE164 || payload.phone || null,
    email:  payload.email || null,
    source: payload.source || 'web_form',
    funnel: payload.funnel || null,
    status: payload.status || 'New',
    intent: payload.intent || null,
    notes:  payload.notes || null,
    tags:   Array.isArray(payload.tags) ? payload.tags : (payload.funnel ? [payload.funnel] : [])
  };
  if (payload.contact_id)   insertRow.contact_id   = payload.contact_id;
  if (payload.vapi_call_id) insertRow.vapi_call_id = payload.vapi_call_id;
  if (payload.payload)      insertRow.payload      = payload.payload;

  let { data, error } = await supabaseAdmin.from('leads').insert(insertRow).select('id').single();
  if (error && /column .* does not exist/i.test(error.message)) {
    // Strip optional columns and retry.
    const { tags, funnel, intent, payload: pl, ...legacy } = insertRow;
    const retry = await supabaseAdmin.from('leads').insert(legacy).select('id').single();
    data = retry.data; error = retry.error;
  }
  if (error) throw error;
  return { id: data.id, created: true };
}
