-- © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
-- Migration 0013: Products, Sales, and Sales Events tables
-- + funnel_sync_url column on clients

-- ============================================================
-- Products table
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name          text NOT NULL,
  description   text,
  price         decimal NOT NULL DEFAULT 0,
  currency      text NOT NULL DEFAULT 'usd',
  stripe_price_id     text,
  stripe_payment_link text,
  image_url     text,
  is_active     boolean NOT NULL DEFAULT true,
  show_in_funnel boolean NOT NULL DEFAULT false,
  funnel_pages  text[] DEFAULT '{}',
  display_order int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_products_client ON products(client_id);

-- ============================================================
-- Sales table
-- ============================================================
CREATE TABLE IF NOT EXISTS sales (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  product_id        uuid REFERENCES products(id) ON DELETE SET NULL,
  stripe_session_id text UNIQUE,
  amount            decimal NOT NULL DEFAULT 0,
  currency          text NOT NULL DEFAULT 'usd',
  customer_name     text,
  customer_email    text,
  customer_phone    text,
  payment_status    text NOT NULL DEFAULT 'paid',
  source            text DEFAULT 'direct',
  refunded_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_client ON sales(client_id);
CREATE INDEX IF NOT EXISTS idx_sales_product ON sales(product_id);
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at DESC);

-- ============================================================
-- Sales events table (audit log)
-- ============================================================
CREATE TABLE IF NOT EXISTS sales_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id     uuid REFERENCES sales(id) ON DELETE CASCADE,
  event_type  text NOT NULL,
  metadata    jsonb DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_events_sale ON sales_events(sale_id);

-- ============================================================
-- Add funnel_sync_url to clients
-- ============================================================
ALTER TABLE clients ADD COLUMN IF NOT EXISTS funnel_sync_url text;

-- Set known client funnel URLs
UPDATE clients SET funnel_sync_url = 'https://www.theflexfacility.com/api/products/sync'
  WHERE slug = 'flex-facility' AND funnel_sync_url IS NULL;

UPDATE clients SET funnel_sync_url = 'https://www.islaystudiosllc.com/api/products/sync'
  WHERE slug = 'islay-studios' AND funnel_sync_url IS NULL;

-- ============================================================
-- RLS policies — each client sees only their own data
-- ============================================================
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY products_client_policy ON products
  FOR ALL USING (client_id = public.current_client_id());

CREATE POLICY sales_client_policy ON sales
  FOR ALL USING (client_id = public.current_client_id());

CREATE POLICY sales_events_client_policy ON sales_events
  FOR ALL USING (
    sale_id IN (SELECT id FROM sales WHERE client_id = public.current_client_id())
  );
