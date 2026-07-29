// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Slug resolver for public /api/external/* endpoints. Historically
// each storefront calls the portal with a single slug matching its
// clients.slug value. When a tenant merges or renames, the deployed
// storefront can still be pointing at the old slug — instead of
// forcing a coordinated redeploy, the clients row keeps the old
// slug in clients.slug_aliases[] and lookups fall through to it.
//
// Precedence:
//   1. Direct match on clients.slug          (canonical)
//   2. Containment in clients.slug_aliases[] (legacy fallback)
//
// Returns the clients row (with .id, .slug, and any requested cols)
// or null. Passes error up if the lookup itself fails.

import { supabaseAdmin } from './supabase.js';

// Resolve a storefront-supplied slug to a clients row. `cols` is the
// SELECT column list — caller decides what it needs (matches the
// existing endpoints' behavior of narrowing the select to reduce
// round-trip payload).
export async function resolveClientBySlug(slug, cols = 'id, slug') {
  const s = String(slug || '').trim();
  if (!s) return { data: null, error: null };

  // 1. Canonical
  let { data, error } = await supabaseAdmin
    .from('clients').select(cols).eq('slug', s).maybeSingle();
  if (error) {
    // Tolerant of the slug_aliases column not being present on older
    // schemas — only relevant for the fallback path below.
    if (!/column .*slug.*does not exist/i.test(error.message || '')) {
      return { data: null, error };
    }
  }
  if (data) return { data, error: null };

  // 2. Legacy alias fallback. slug_aliases is a text[]; contains-any
  //    using `.contains(...)` with a single-element array works whether
  //    the requested slug is in position 0 or N.
  try {
    const alias = await supabaseAdmin
      .from('clients').select(cols).contains('slug_aliases', [s]).maybeSingle();
    if (alias.error && !/column .*slug_aliases.* does not exist/i.test(alias.error.message || '')) {
      return { data: null, error: alias.error };
    }
    return { data: alias.data || null, error: null };
  } catch {
    // slug_aliases column missing on this DB — treat as no alias.
    return { data: null, error: null };
  }
}
