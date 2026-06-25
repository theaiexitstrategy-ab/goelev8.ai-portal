// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
//
// Provisioning agent — runs after a client completes onboarding and
// sets their tenant unit up. Triggered manually from Master Admin
// (admin action 'provision-tenant') or by a follow-up webhook when
// the onboarding flow flips clients.onboarding_status='complete'.
//
// Architectural notes:
//   - The existing `clients` table is the tenant record. The spec
//     called for a separate `tenants` table; we map every "tenant"
//     reference to a clients row to avoid forking the schema.
//   - RLS policies for the new tables (client_info, client_assets,
//     domains, keywords, provisioning_log) are applied by the
//     verify-migrations runner — the agent doesn't try to ALTER
//     policies at runtime.
//   - Stripe Connect is already wired (api/portal/connect.js). The
//     agent VERIFIES connection state but never reissues OAuth or
//     creates accounts on a tenant's behalf — that requires the
//     human to click Connect in the portal Settings panel.
//
// Idempotent: re-running on a fully-provisioned client is safe.
// Each step checks for existing rows before inserting.

import { supabaseAdmin } from './supabase.js';
import { generateLocalSeoKeywords } from './provisioning-keywords.js';
import { sendProvisioningEmail } from './provisioning-notify.js';

const ASSETS_BUCKET = 'client-assets';
const ALWAYS_INCLUDE_KEYWORD = 'iSlay Studios';
const DEFAULT_PLATFORM_FEE = 10;

// Read all the inputs the agent needs in one pass.
async function loadProvisioningContext(clientId) {
  const { data: client, error: clientErr } = await supabaseAdmin
    .from('clients').select('*').eq('id', clientId).maybeSingle();
  if (clientErr) throw new Error('clients lookup failed: ' + clientErr.message);
  if (!client)    throw new Error('client_not_found');

  const { data: info } = await supabaseAdmin
    .from('client_info').select('*').eq('client_id', clientId).maybeSingle();

  const { data: assets } = await supabaseAdmin
    .from('client_assets').select('*').eq('client_id', clientId)
    .order('rank', { ascending: true });

  return { client, info: info || null, assets: assets || [] };
}

// Tolerant required-fields check. Missing data → still proceed but
// surface the gap in the warnings list so the admin notification
// email reads "provisioned with caveats".
function auditRequiredFields(ctx) {
  const warnings = [];
  if (!ctx.client.business_name)            warnings.push('clients.business_name is empty');
  if (!ctx.client.slug)                     warnings.push('clients.slug is empty');
  if (!ctx.info?.owner_email)               warnings.push('client_info.owner_email is empty');
  if (!ctx.info?.services?.length)          warnings.push('no services on client_info');
  if (!ctx.client.stripe_connected_account_id) {
    warnings.push('Stripe Connect not linked — Settings → Integrations');
  }
  return warnings;
}

// STEP 2 — copy brand fields from client_info onto clients. The
// clients row is the tenant record; we keep brand display fields
// on it so existing UI queries don't need to JOIN.
async function syncBrandFieldsToClient({ client, info }) {
  if (!info) return { ok: true, skipped: 'no_client_info' };
  const patch = {};
  if (info.business_name   && !client.business_name)   patch.business_name   = info.business_name;
  if (info.primary_color   && !client.primary_color)   patch.primary_color   = info.primary_color;
  if (info.secondary_color && !client.secondary_color) patch.secondary_color = info.secondary_color;
  if (info.booking_url     && !client.booking_url)     patch.booking_url     = info.booking_url;
  if (info.owner_name      && !client.owner_name)      patch.owner_name      = info.owner_name;
  if (info.owner_email     && !client.owner_email)     patch.owner_email     = info.owner_email;
  if (!client.onboarded_at) patch.onboarded_at = new Date().toISOString();
  if (!Object.keys(patch).length) return { ok: true, no_changes: true };
  const { error } = await supabaseAdmin.from('clients').update(patch).eq('id', client.id);
  if (error) throw new Error('clients update failed: ' + error.message);
  return { ok: true, patched_fields: Object.keys(patch) };
}

// STEP 4 — move uploaded assets from the onboarding temp path to the
// permanent client-assets/<slug>/ folder and update file_url. Storage
// API moves are best-effort: if the source is already at the target
// path (re-run), or the bucket isn't configured, we keep the existing
// URLs intact.
async function relocateAssets({ client, assets }) {
  if (!assets.length) return { ok: true, moved: 0, skipped: 0 };
  let moved = 0, skipped = 0;
  for (const a of assets) {
    const src = a.file_path;
    if (!src) { skipped++; continue; }
    const filename = src.split('/').pop();
    const dst = `${client.slug}/${filename}`;
    if (src === dst) { skipped++; continue; }
    try {
      const mv = await supabaseAdmin.storage.from(ASSETS_BUCKET).move(src, dst);
      if (mv.error) { skipped++; continue; }
      const { data: pub } = supabaseAdmin.storage.from(ASSETS_BUCKET).getPublicUrl(dst);
      await supabaseAdmin.from('client_assets')
        .update({ file_path: dst, file_url: pub?.publicUrl || a.file_url })
        .eq('id', a.id);
      moved++;
    } catch { skipped++; }
  }
  // If the client has a logo asset and clients.logo_url isn't set
  // yet, propagate the first label='logo' URL onto the clients row.
  if (!client.logo_url) {
    const { data: logo } = await supabaseAdmin
      .from('client_assets').select('file_url')
      .eq('client_id', client.id).eq('label', 'logo')
      .order('rank', { ascending: true }).limit(1).maybeSingle();
    if (logo?.file_url) {
      await supabaseAdmin.from('clients')
        .update({ logo_url: logo.file_url }).eq('id', client.id);
    }
  }
  return { ok: true, moved, skipped };
}

// STEP 6 — write the requested domain (if any). Status starts at
// 'requested' so the operator can mark it purchased/configured/live
// later from the admin domains UI.
async function registerDomainPreference({ client, info }) {
  const requested = info?.domain_preference;
  if (!requested) return { ok: true, skipped: 'no_domain_preference' };
  // Dedupe: don't insert another row if one already exists for this
  // client + domain.
  const { data: existing } = await supabaseAdmin
    .from('domains').select('id')
    .eq('client_id', client.id)
    .eq('requested_domain', requested)
    .maybeSingle();
  if (existing) return { ok: true, already_present: true };
  const { error } = await supabaseAdmin.from('domains').insert({
    client_id: client.id,
    requested_domain: requested,
    status: 'requested'
  });
  if (error) throw new Error('domains insert failed: ' + error.message);
  return { ok: true, domain: requested };
}

// STEP 7 — verify Stripe Connect setup. We do NOT auto-create
// connected accounts. The existing OAuth flow (api/portal/connect.js)
// is what links a tenant's existing Stripe to GoElev8. The agent
// only confirms the link is in place and the per-tenant platform fee
// percent is set.
async function verifyStripeConnect({ client }) {
  const linked = !!client.stripe_connected_account_id;
  const feePct = client.platform_fee_pct ?? DEFAULT_PLATFORM_FEE;
  if (client.platform_fee_pct == null) {
    await supabaseAdmin.from('clients')
      .update({ platform_fee_pct: DEFAULT_PLATFORM_FEE }).eq('id', client.id);
  }
  return {
    ok: true,
    connected: linked,
    account: client.stripe_connected_account_id || null,
    platform_fee_pct: feePct,
    next_action: linked ? null : 'Tenant must click Connect Stripe in Settings → Integrations'
  };
}

// STEP 8 — seed keywords. Three sources:
//   client_provided  — verbatim from onboarding intake
//   platform_network — always include 'iSlay Studios'
//   auto             — Claude generates 3 local-SEO keywords
async function seedKeywords({ client, info }) {
  const out = { client_provided: 0, platform_network: 0, auto: 0, errors: [] };

  async function upsert(keyword, source) {
    const trimmed = String(keyword || '').trim();
    if (!trimmed) return false;
    const { error } = await supabaseAdmin.from('keywords').insert({
      client_id: client.id, keyword: trimmed, source, active: true
    });
    if (error && !/duplicate key|unique/i.test(error.message)) {
      out.errors.push(error.message);
      return false;
    }
    return !error;
  }

  for (const k of (info?.keywords || [])) {
    if (await upsert(k, 'client_provided')) out.client_provided++;
  }
  if (await upsert(ALWAYS_INCLUDE_KEYWORD, 'platform_network')) out.platform_network++;

  // Claude-generated local SEO keywords. Failures are non-fatal —
  // the rest of provisioning still completes.
  try {
    const autoKeywords = await generateLocalSeoKeywords({
      businessName: client.business_name || info?.business_name || 'Unnamed Business',
      city:         info?.city  || null,
      state:        info?.state || null,
      services:     info?.services || []
    });
    for (const k of autoKeywords) {
      if (await upsert(k, 'auto')) out.auto++;
    }
  } catch (e) {
    out.errors.push('claude keyword gen failed: ' + (e?.message || e));
  }

  return { ok: true, ...out };
}

// STEP 9 — finalize: flip clients.onboarding_status='provisioned'
// and write a provisioning_log row. Both happen even if individual
// steps emitted errors — the log captures what worked + what didn't.
async function finalize({ client, log, triggeredBy }) {
  await supabaseAdmin.from('provisioning_log').insert({
    client_id: client.id,
    completed_steps: log.completed,
    errors: log.errors,
    triggered_by: triggeredBy || 'unknown'
  });
  await supabaseAdmin.from('clients').update({
    onboarding_status: 'provisioned'
  }).eq('id', client.id);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────
// Main orchestrator. Each step pushes onto log.completed; thrown
// errors push onto log.errors but DON'T abort — best-effort across
// the board so one broken step doesn't strand a tenant.
export async function provisionTenant({ clientId, triggeredBy } = {}) {
  if (!clientId) throw new Error('clientId required');

  const log = { completed: [], errors: [], warnings: [] };
  const safe = async (name, fn) => {
    try { const r = await fn(); log.completed.push({ step: name, result: r }); return r; }
    catch (e) {
      const msg = e?.message || String(e);
      log.errors.push({ step: name, error: msg });
      console.error(`[provisioning] ${name} failed:`, msg);
      return null;
    }
  };

  const ctx = await loadProvisioningContext(clientId);
  log.warnings = auditRequiredFields(ctx);

  // Steps run in spec order. Step 1 (read inputs) ran above as ctx.
  await safe('sync_brand_fields', () => syncBrandFieldsToClient(ctx));
  await safe('relocate_assets',   () => relocateAssets(ctx));
  await safe('register_domain',   () => registerDomainPreference(ctx));
  await safe('verify_stripe',     () => verifyStripeConnect(ctx));
  await safe('seed_keywords',     () => seedKeywords(ctx));
  await safe('finalize',          () => finalize({ client: ctx.client, log, triggeredBy }));

  // Email is fire-and-forget — never throw out of the orchestrator
  // because Resend hiccuped.
  try {
    await sendProvisioningEmail({ ctx, log });
  } catch (e) {
    log.errors.push({ step: 'send_email', error: e?.message || String(e) });
  }

  return {
    client_id: ctx.client.id,
    slug:      ctx.client.slug,
    business_name: ctx.client.business_name,
    warnings:  log.warnings,
    errors:    log.errors,
    completed: log.completed.map(s => s.step),
    portal_url: `https://portal.goelev8.ai` // brand home route TBD; see follow-up
  };
}
