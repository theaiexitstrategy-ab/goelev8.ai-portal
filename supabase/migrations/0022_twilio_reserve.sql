-- © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
-- Twilio Reserve accounting layer.
--
-- Customer payments land in the GoElev8 Stripe account. There's no direct
-- rail to push that money into Twilio's balance, but we still want to know
-- on a per-purchase basis how much of each sale must stay reserved to cover
-- Twilio's actual SMS cost, and how much is true platform margin.
--
-- Mechanism:
--   - On every credit-pack purchase the webhook inserts a +reserve row.
--   - On every SMS send the send path inserts a -reserve row.
--   - clients.twilio_reserve_cents is a running balance that mirrors the
--     ledger sum (kept in sync with two RPCs below) so a single SELECT
--     gives the current "should be set aside for Twilio" number.

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS twilio_reserve_cents bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.twilio_reserves (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  delta_cents   bigint NOT NULL,
  reason        text NOT NULL,           -- 'pack_purchase' | 'sms_send' | 'adjustment' | 'backfill'
  ref_id        text,                    -- stripe payment_intent / twilio sid / etc
  pack          text,
  segments      integer,                 -- only set for sms_send rows
  amount_cents  integer,                 -- gross purchase amount for pack rows
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS twilio_reserves_client_idx
  ON public.twilio_reserves(client_id, created_at DESC);

ALTER TABLE public.twilio_reserves ENABLE ROW LEVEL SECURITY;

-- Tenant members can read their own reserve history; service role bypasses
-- RLS for the webhook + SMS send paths that write rows.
DROP POLICY IF EXISTS twilio_reserves_member_select ON public.twilio_reserves;
CREATE POLICY twilio_reserves_member_select ON public.twilio_reserves
  FOR SELECT TO authenticated
  USING (
    client_id IN (SELECT client_id FROM public.client_users WHERE user_id = auth.uid())
    OR (auth.jwt() ->> 'email') = 'ab@goelev8.ai'
    OR EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = auth.uid())
  );

-- Atomic running-balance helpers — use these in the API/webhook so the
-- ledger row + balance update never drift.
-- Trigger that debits the Twilio reserve every time the credit_ledger
-- records an SMS spend. Gives us a single integration point so every
-- existing send path (welcome, nudge, blast, manual messages, islay
-- artist confirmation, cron-fired nudges) flows into the reserve
-- without per-call code changes.
--
-- Per-segment cost is read from a Postgres setting; defaults to 1¢ if
-- unset. Override at any time via:
--   ALTER DATABASE postgres SET app.twilio_cost_cents = '2';
CREATE OR REPLACE FUNCTION public.debit_twilio_reserve_on_sms()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_per_segment_cents int;
  v_segments int;
  v_cost int;
BEGIN
  IF NEW.delta < 0
     AND NEW.reason IN ('sms_send', 'sms_blast', 'welcome_sms', 'nudge_send', 'islay_sms')
  THEN
    v_segments := -NEW.delta;
    BEGIN
      v_per_segment_cents := COALESCE(current_setting('app.twilio_cost_cents', true)::int, 1);
    EXCEPTION WHEN others THEN
      v_per_segment_cents := 1;
    END;
    v_cost := v_segments * v_per_segment_cents;

    UPDATE public.clients
       SET twilio_reserve_cents = COALESCE(twilio_reserve_cents, 0) - v_cost
     WHERE id = NEW.client_id;

    INSERT INTO public.twilio_reserves
      (client_id, delta_cents, reason, ref_id, segments)
    VALUES
      (NEW.client_id, -v_cost, NEW.reason, NEW.ref_id, v_segments);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS credit_ledger_debit_reserve ON public.credit_ledger;
CREATE TRIGGER credit_ledger_debit_reserve
  AFTER INSERT ON public.credit_ledger
  FOR EACH ROW EXECUTE FUNCTION public.debit_twilio_reserve_on_sms();

CREATE OR REPLACE FUNCTION public.adjust_twilio_reserve(
  p_client_id uuid,
  p_delta_cents bigint,
  p_reason text,
  p_ref_id text DEFAULT NULL,
  p_pack text DEFAULT NULL,
  p_segments integer DEFAULT NULL,
  p_amount_cents integer DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  v_new_balance bigint;
BEGIN
  UPDATE public.clients
     SET twilio_reserve_cents = COALESCE(twilio_reserve_cents, 0) + p_delta_cents
   WHERE id = p_client_id
   RETURNING twilio_reserve_cents INTO v_new_balance;

  INSERT INTO public.twilio_reserves
    (client_id, delta_cents, reason, ref_id, pack, segments, amount_cents)
  VALUES
    (p_client_id, p_delta_cents, p_reason, p_ref_id, p_pack, p_segments, p_amount_cents);

  RETURN v_new_balance;
END;
$$;
