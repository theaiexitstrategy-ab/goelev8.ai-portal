// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Product-scoped Supabase client factory. Every data-fetching function
// that reads product data must go through getProductClient(slug) —
// hardcoding a Supabase connection to any single project is a bug now
// that the portal is multi-tenant.
//
// SERVER-SIDE ONLY. This module reads process.env.* to resolve the
// service role key. It MUST NEVER be imported from browser-bound code
// (app.js, index.html scripts). The portal repo has no bundler that
// would auto-strip server-only imports, so importing this module from
// app.js would either fail silently (process.env undefined in browser)
// or leak env var VALUES into the JS payload depending on hosting.
// Enforcement is by convention: only api/*.js files import this.

import { createClient } from '@supabase/supabase-js';
import { PRODUCTS, getProductBySlug } from './products.config.js';

// One Supabase client per product slug. First access constructs it
// (also validates env vars); subsequent calls reuse the cached
// instance. Cache is per-process — Vercel serverless functions may
// spin up multiple instances, and each gets its own map, but that's
// fine (the SDK is lightweight to construct).
const clientCache = new Map();

// Return a service-role-scoped Supabase client for the given product.
// Throws a clear error if:
//   - the slug isn't registered in products.config.js
//   - either env var (URL or service key) is unset in Vercel
// The thrown error names the missing env var(s) so the operator can
// fix without spelunking.
export function getProductClient(slug) {
  if (clientCache.has(slug)) return clientCache.get(slug);

  const product = getProductBySlug(slug);
  if (!product) {
    throw new Error(
      `Unknown product slug: "${slug}". Register it in lib/products.config.js.`
    );
  }
  const url = process.env[product.urlEnvVar];
  const serviceKey = process.env[product.serviceKeyEnvVar];
  const missing = [];
  if (!url) missing.push(product.urlEnvVar);
  if (!serviceKey) missing.push(product.serviceKeyEnvVar);
  if (missing.length) {
    throw new Error(
      `Product "${slug}" (${product.name}) is not configured — ` +
      `missing env vars in Vercel: ${missing.join(', ')}. Add them, then redeploy.`
    );
  }
  const client = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  clientCache.set(slug, client);
  return client;
}

// Convenience: read the selected product slug from an incoming request
// header. The portal SPA sets 'x-product-slug' on every api() call
// whenever a product is selected in the sidebar. Returns null when no
// product is selected (callers fall back to the platform's own
// supabaseAdmin for non-product-scoped queries).
export function getProductSlugFromReq(req) {
  const raw = req?.headers?.['x-product-slug'];
  const slug = String(raw || '').trim();
  return slug || null;
}

// Resolve the product client directly from the request. Returns null
// when no product slug is set — routes that require a product must
// null-check and return a 400.
export function getProductClientFromReq(req) {
  const slug = getProductSlugFromReq(req);
  if (!slug) return null;
  return getProductClient(slug);
}

// Diagnostic — report which products' env vars are present in this
// process WITHOUT exposing any values. Used by /api/products so the
// sidebar switcher can render "connected" vs "coming soon" states.
// Never returns keys, URLs, or any credential data.
export function getProductStatuses() {
  return PRODUCTS.map(p => {
    const hasUrl = !!process.env[p.urlEnvVar];
    const hasKey = !!process.env[p.serviceKeyEnvVar];
    // Effective status: declared 'active' overridden to 'coming-soon'
    // if env vars aren't actually set yet, so the switcher never
    // pretends a broken product is live.
    const effective = (hasUrl && hasKey) ? (p.status === 'archived' ? 'archived' : 'active') : 'coming-soon';
    return {
      slug:     p.slug,
      name:     p.name,
      domain:   p.domain,
      declared: p.status,
      status:   effective,
      hasUrl,
      hasKey,
      connected: hasUrl && hasKey
    };
  });
}
