// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Multi-tenant product registry — the source of truth for what
// "products" (client offerings GoElev8.AI builds & operates) this
// portal connects to. Each product may have its OWN Supabase project
// with its own URL + service role key, so the portal is architected
// as a fan-out console: it holds N connections, one per product,
// rather than reading from a single shared database.
//
// SAFETY CONTRACT
// - This file NEVER stores actual credentials. Only:
//   - safe display metadata (slug, name, domain, status)
//   - env var NAMES pointing to where credentials live
// - Actual URL + service role key values live in Vercel env vars,
//   namespaced per product (e.g. DANCEISASPORT_SUPABASE_URL).
// - This file IS safe to commit and safe to import in any context.
//   The env var VALUES are only ever read by lib/product-client.js
//   which is server-side only.
//
// Adding a new product:
//   1. Add a new object to PRODUCTS below with a stable slug + env var
//      names (URL_ENV_VAR and SERVICE_KEY_ENV_VAR).
//   2. In Vercel → Settings → Environment Variables, add both env
//      vars with the actual credentials for that product.
//   3. Redeploy. The sidebar switcher, the factory, and any product-
//      scoped API routes will pick it up automatically.

// status values:
//   'active'       — env vars set, ready for data queries
//   'coming-soon'  — registered but backend not yet provisioned;
//                    switcher renders it grayed out
//   'archived'     — retired, hidden from the switcher
export const PRODUCTS = [
  {
    slug:              'danceisasport',
    name:              'Dance is a Sport',
    domain:            'danceisasport.com',
    status:            'coming-soon',
    urlEnvVar:         'DANCEISASPORT_SUPABASE_URL',
    serviceKeyEnvVar:  'DANCEISASPORT_SUPABASE_SERVICE_KEY',
  }
];

// Lookup by slug. Returns null for unknown slugs so callers can render
// a "not found" state rather than throw.
export function getProductBySlug(slug) {
  if (!slug) return null;
  return PRODUCTS.find(p => p.slug === slug) || null;
}

// Public metadata list — safe for any surface (including browser).
// Strips env var names since browsers have no legitimate reason to
// know them; keeps the payload minimal.
export function publicProductList() {
  return PRODUCTS.map(({ slug, name, domain, status }) => ({ slug, name, domain, status }));
}
