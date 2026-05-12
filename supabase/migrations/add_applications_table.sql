-- Applications table — receives artist applications submitted from each
-- tenant's public website (e.g. iSlay Studios' apply form) via the
-- /functions/v1/submit-application Edge Function. Stores each
-- submission with a free-text client_id slug (NOT a uuid FK) so the
-- public form can post with a slug like 'islay_studios' without
-- needing to know any internal client uuids.
--
-- Bundled into the apply-pending-migrations runner so 'Run Pending
-- Migrations' applies this. Also runnable standalone in Supabase SQL
-- Editor (project bnkoqybkmwtrlorhowyv).
--
-- Idempotent: IF NOT EXISTS / DROP POLICY IF EXISTS guards mean it's
-- safe to re-run on a schema that already has the table.

CREATE TABLE IF NOT EXISTS public.applications (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  status text DEFAULT 'new' NOT NULL,  -- 'new', 'reviewed', 'interview', 'hired', 'declined'
  full_name text,
  phone text,
  email text,
  instagram text,
  city_state text,
  specialty text[],
  years_experience text,
  employment_status text,
  has_clientele boolean,
  clientele_count text,
  bio text,
  portfolio_url text,
  desired_start date,
  booth_preference text,
  schedule text,
  referral_source text,
  notes text
);

CREATE INDEX IF NOT EXISTS applications_client_created_idx
  ON public.applications(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS applications_client_status_idx
  ON public.applications(client_id, status);

ALTER TABLE public.applications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "allow_anon_insert" ON public.applications;
CREATE POLICY "allow_anon_insert" ON public.applications
  FOR INSERT TO anon WITH CHECK (true);

DROP POLICY IF EXISTS "allow_auth_read" ON public.applications;
CREATE POLICY "allow_auth_read" ON public.applications
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "allow_auth_update" ON public.applications;
CREATE POLICY "allow_auth_update" ON public.applications
  FOR UPDATE TO authenticated USING (true);
