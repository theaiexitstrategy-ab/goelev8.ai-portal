-- Merch storefront tables + per-tenant portal API key.
-- Bundled into the apply-pending-migrations runner so 'Run Pending
-- Migrations' applies it. Also paste-able into Supabase SQL Editor
-- directly. Idempotent.
--
-- Used by:
--   - public storefront at /merch on each tenant's marketing site
--     (e.g. willpowerfitnessfactory.com/merch) which fetches prices
--     from /api/external/products, validates coupons via
--     /api/external/coupons/validate, and POSTs completed orders
--     to /api/external/orders.
--   - portal Merch tab where the tenant operator manages products,
--     coupons, and views the order ledger.

-- ============================================================
-- clients.portal_api_key — per-tenant Bearer token used by the
-- external storefront when calling /api/external/*. Each tenant has
-- exactly one active key; rotate via Master Admin if leaked.
-- ============================================================
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS portal_api_key text;
CREATE UNIQUE INDEX IF NOT EXISTS clients_portal_api_key_uniq
  ON public.clients(portal_api_key)
  WHERE portal_api_key IS NOT NULL;

-- ============================================================
-- merch_products — sellable items per tenant. product_key is the
-- stable string the storefront uses in its cart payload ('tee',
-- 'tank', 'hoodie', 'snapback'…). UNIQUE per tenant so we can
-- upsert on (client_id, product_key).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.merch_products (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  product_key              text NOT NULL,
  name                     text NOT NULL,
  description              text,
  base_price_cents         integer NOT NULL DEFAULT 0 CHECK (base_price_cents >= 0),
  compare_at_price_cents   integer CHECK (compare_at_price_cents IS NULL OR compare_at_price_cents >= 0),
  image_url                text,
  printify_product_id      text,
  is_active                boolean NOT NULL DEFAULT true,
  sort_order               integer NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merch_products_client_key_uniq UNIQUE (client_id, product_key)
);
CREATE INDEX IF NOT EXISTS merch_products_client_sort_idx
  ON public.merch_products(client_id, sort_order);

-- ============================================================
-- merch_coupons — promo codes the tenant operator creates from the
-- portal. Code matched case-insensitively at validate time.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.merch_coupons (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  code                text NOT NULL,
  name                text,
  discount_type       text NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
  discount_value      integer NOT NULL CHECK (discount_value > 0),  -- percent 1-100 OR cents off
  min_subtotal_cents  integer CHECK (min_subtotal_cents IS NULL OR min_subtotal_cents >= 0),
  expires_at          timestamptz,
  max_uses            integer CHECK (max_uses IS NULL OR max_uses > 0),
  used_count          integer NOT NULL DEFAULT 0,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merch_coupons_client_code_uniq UNIQUE (client_id, code)
);
CREATE INDEX IF NOT EXISTS merch_coupons_client_active_idx
  ON public.merch_coupons(client_id, is_active);

-- ============================================================
-- merch_orders — one row per completed Stripe checkout. Idempotent
-- via stripe_payment_id UNIQUE so a retry from the storefront (or
-- a webhook backup path) never double-writes.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.merch_orders (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  customer_name            text,
  customer_email           text,
  customer_phone           text,
  shipping_address1        text,
  shipping_address2        text,
  shipping_city            text,
  shipping_state           text,
  shipping_zip             text,
  shipping_country         text,
  subtotal_cents           integer NOT NULL DEFAULT 0,
  shipping_cents           integer NOT NULL DEFAULT 0,
  discount_cents           integer NOT NULL DEFAULT 0,
  total_cents              integer NOT NULL DEFAULT 0,
  coupon_code              text,
  stripe_payment_id        text NOT NULL,
  printify_order_id        text,
  external_order_number    text,
  status                   text NOT NULL DEFAULT 'paid'
    CHECK (status IN ('paid', 'fulfilled', 'shipped', 'refunded')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merch_orders_stripe_payment_uniq UNIQUE (stripe_payment_id)
);
CREATE INDEX IF NOT EXISTS merch_orders_client_created_idx
  ON public.merch_orders(client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.merch_order_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES public.merch_orders(id) ON DELETE CASCADE,
  product_key   text,
  name          text,
  color         text,
  size          text,
  quantity      integer NOT NULL DEFAULT 1,
  price_cents   integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS merch_order_items_order_idx
  ON public.merch_order_items(order_id);

-- ============================================================
-- Row Level Security: portal endpoints hit these tables via
-- supabaseAdmin which bypasses RLS, so policies are defense-in-depth
-- — tenant-scoped reads/writes if any path ever uses anon/auth keys.
-- ============================================================
ALTER TABLE public.merch_products    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.merch_coupons     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.merch_orders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.merch_order_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS merch_products_tenant_all ON public.merch_products;
CREATE POLICY merch_products_tenant_all ON public.merch_products
  FOR ALL
  USING      (client_id = public.current_client_id())
  WITH CHECK (client_id = public.current_client_id());

DROP POLICY IF EXISTS merch_coupons_tenant_all ON public.merch_coupons;
CREATE POLICY merch_coupons_tenant_all ON public.merch_coupons
  FOR ALL
  USING      (client_id = public.current_client_id())
  WITH CHECK (client_id = public.current_client_id());

DROP POLICY IF EXISTS merch_orders_tenant_all ON public.merch_orders;
CREATE POLICY merch_orders_tenant_all ON public.merch_orders
  FOR ALL
  USING      (client_id = public.current_client_id())
  WITH CHECK (client_id = public.current_client_id());

DROP POLICY IF EXISTS merch_order_items_tenant_select ON public.merch_order_items;
CREATE POLICY merch_order_items_tenant_select ON public.merch_order_items
  FOR SELECT
  USING (order_id IN (
    SELECT id FROM public.merch_orders WHERE client_id = public.current_client_id()
  ));

DROP TRIGGER IF EXISTS merch_products_touch ON public.merch_products;
CREATE TRIGGER merch_products_touch BEFORE UPDATE ON public.merch_products
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS merch_coupons_touch ON public.merch_coupons;
CREATE TRIGGER merch_coupons_touch BEFORE UPDATE ON public.merch_coupons
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
