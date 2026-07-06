// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// GET /api/products — list the products this portal is connected to.
// Powers the sidebar product switcher AND (for product-tenants like
// danceisasport) the tenant sidebar's tab labels/icons.
//
// Two access tiers:
//   - Master admin  → full metadata including connection status
//                     booleans (hasUrl, hasKey, connected).
//   - Tenant user   → publicProductList only (slug, name, domain,
//                     status, tabs). Needed so a product-tenant's SPA
//                     can render its own tabs' labels + icons without
//                     hardcoding them client-side.
//
// SAFETY: neither tier ever returns env var VALUES, backing Supabase
// URLs, or any credential material. publicProductList strips even the
// env var NAMES.
//
// Auth is `requireUser` (any authenticated session), not
// `requireAdmin`, so a danceisasport tenant login can fetch its own
// tab metadata. The response fan-out per role happens below.

import { requireUser, methodGuard } from '../lib/auth.js';
import { publicProductList } from '../lib/products.config.js';
import { getProductStatuses } from '../lib/product-client.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;
  const ctx = await requireUser(req, res, { requireClient: false }); if (!ctx) return;
  if (ctx.isAdmin) {
    return res.status(200).json({ products: getProductStatuses() });
  }
  return res.status(200).json({ products: publicProductList() });
}
