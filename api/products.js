// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// GET /api/products — list the products this portal is connected to.
// Powers the sidebar product switcher.
//
// Returns:
//   {
//     products: [
//       { slug, name, domain, status, connected, ... }
//     ]
//   }
//
// SAFETY: the response never includes env var VALUES, URLs of the
// backing Supabase projects, or any credentials. Only safe metadata
// + a boolean "connected" flag per product so the switcher can render
// "coming soon" vs "live".
//
// Auth: master admin only. The product portfolio is the operator's
// cross-tenant view — regular tenant users of the SMS SaaS features
// don't have a legitimate reason to see this list.

import { requireAdmin, methodGuard } from '../lib/auth.js';
import { getProductStatuses } from '../lib/product-client.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;
  const ctx = await requireAdmin(req, res); if (!ctx) return;
  return res.status(200).json({ products: getProductStatuses() });
}
