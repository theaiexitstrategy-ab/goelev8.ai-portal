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

// Read-time dedupe shared by /api/portal/crm?action=leads and
// /api/portal/analytics so both endpoints report the same Leads
// Captured count. Same family-share guard as the write-side helper:
// (phone OR email) + first-name. Different first names at the same
// phone stay separate. Blank-name rows roll into a phone/email match.
//
// Input: rows already filtered by client_id and deleted_at IS NULL.
// Output: deduped array, same shape as input.
export function dedupeLeadRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const norm = (p) => String(p || '').replace(/[^\d+]/g, '');
  const fn = (n) => String(n || '').trim().toLowerCase().split(/\s+/)[0] || '';
  const ascending = rows.slice().sort((a, b) =>
    new Date(a.created_at) - new Date(b.created_at));
  const seen = new Map();
  const out = [];
  const lookupCanonical = (r) => {
    const f = fn(r.name);
    const phoneKey = norm(r.phone);
    const emailKey = (r.email || '').trim().toLowerCase();
    if (phoneKey && f) { const k = 'p:' + phoneKey + '|n:' + f; if (seen.has(k)) return seen.get(k); }
    if (emailKey && f) { const k = 'e:' + emailKey + '|n:' + f; if (seen.has(k)) return seen.get(k); }
    if (!f) {
      if (phoneKey) for (const [k, v] of seen) if (k.startsWith('p:' + phoneKey + '|')) return v;
      if (emailKey) for (const [k, v] of seen) if (k.startsWith('e:' + emailKey + '|')) return v;
    }
    return null;
  };
  for (const r of ascending) {
    const canonical = lookupCanonical(r);
    if (canonical) {
      const ex = Array.isArray(canonical.tags) ? canonical.tags : [];
      const nx = Array.isArray(r.tags) ? r.tags : [];
      if (nx.length) canonical.tags = [...new Set([...ex, ...nx])];
      if (!canonical.paid_at && r.paid_at) canonical.paid_at = r.paid_at;
      for (const k of ['name', 'phone', 'email']) if (!canonical[k] && r[k]) canonical[k] = r[k];
      continue;
    }
    out.push(r);
    const f = fn(r.name);
    const phoneKey = norm(r.phone);
    const emailKey = (r.email || '').trim().toLowerCase();
    if (phoneKey && f) seen.set('p:' + phoneKey + '|n:' + f, r);
    if (emailKey && f) seen.set('e:' + emailKey + '|n:' + f, r);
    if (phoneKey && !f) seen.set('p:' + phoneKey + '|n:', r);
    if (emailKey && !f) seen.set('e:' + emailKey + '|n:', r);
  }
  return out.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

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
      .is('deleted_at', null)
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
      .is('deleted_at', null)
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
  // Two error shapes mean "this column isn't on the table":
  //   - Postgres direct:  ERROR: column "X" of relation "leads" does not exist
  //   - PostgREST cache:  Could not find the 'X' column of 'leads' in the schema cache
  //                       (code 'PGRST204')
  // The original regex only matched the first form, so PostgREST-style errors
  // skipped the retry and the insert silently dropped — see migration 0030
  // for the prior incident where leads from external sites never landed.
  const isMissingColumn = error && (
    /column .* does not exist/i.test(error.message) ||
    /could not find the .* column/i.test(error.message) ||
    error.code === 'PGRST204'
  );
  if (isMissingColumn) {
    // Strip optional columns and retry.
    const { tags, funnel, intent, payload: pl, ...legacy } = insertRow;
    const retry = await supabaseAdmin.from('leads').insert(legacy).select('id').single();
    data = retry.data; error = retry.error;
  }
  if (error) throw error;
  return { id: data.id, created: true };
}
