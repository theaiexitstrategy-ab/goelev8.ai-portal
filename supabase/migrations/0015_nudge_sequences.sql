-- Nudge sequences: per-business 5-message SMS drip sequence triggered
-- when a lead opts in through their funnel page.

CREATE TABLE public.nudge_sequences (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid        NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  message_number  smallint    NOT NULL CHECK (message_number BETWEEN 1 AND 5),
  message_body    text        NOT NULL DEFAULT '',
  delay_minutes   integer     NOT NULL DEFAULT 0,
  is_active       boolean     NOT NULL DEFAULT true,
  is_custom       boolean     NOT NULL DEFAULT false,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (client_id, message_number)
);

CREATE INDEX nudge_sequences_client_idx ON public.nudge_sequences (client_id, message_number);

-- RLS: same tenant isolation as every other table
ALTER TABLE public.nudge_sequences ENABLE ROW LEVEL SECURITY;

CREATE POLICY nudge_sequences_tenant ON public.nudge_sequences
  FOR ALL USING (
    client_id IN (SELECT client_id FROM public.client_users WHERE user_id = auth.uid())
  );

-- Grant service-role full access (for the event ingest / scheduled sends)
GRANT ALL ON public.nudge_sequences TO service_role;

-- Auto-update updated_at on every change
CREATE OR REPLACE FUNCTION public.nudge_sequences_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER nudge_sequences_updated
  BEFORE UPDATE ON public.nudge_sequences
  FOR EACH ROW EXECUTE FUNCTION public.nudge_sequences_touch();

-- Seed default nudge sequences for every existing client.
-- is_custom = false marks these as platform defaults that the client
-- hasn't personalised yet.
INSERT INTO public.nudge_sequences (client_id, message_number, message_body, delay_minutes, is_active, is_custom)
SELECT
  c.id,
  v.message_number,
  v.message_body,
  v.delay_minutes,
  true,
  false
FROM public.clients c
CROSS JOIN (
  VALUES
    (1, 'Hey [first_name]! [business_name] here. We just got your info — someone will follow up shortly. Reply STOP to opt out.', 0),
    (2, 'Still thinking it over? [business_name] is ready when you are. Check out what we offer: [funnel_url]', 60),
    (3, 'Hey [first_name], just checking in. Spots fill up fast at [business_name]. Want to lock yours in?', 1440),
    (4, 'Last thing — [business_name] wanted to make sure you didn''t miss out. Reply back anytime.', 2880),
    (5, 'We''ll leave the door open. Come back when you''re ready: [funnel_url]', 4320)
) AS v(message_number, message_body, delay_minutes)
ON CONFLICT (client_id, message_number) DO NOTHING;

-- ── Nudge queue: delayed messages waiting for cron pickup ───────────
-- Messages with delay > 10 minutes get persisted here so a scheduled
-- job can poll for due rows and send them.

CREATE TABLE public.nudge_queue (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid        NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  contact_id      uuid        REFERENCES public.contacts(id) ON DELETE SET NULL,
  to_number       text        NOT NULL,
  message_body    text        NOT NULL,
  message_number  smallint    NOT NULL,
  scheduled_for   timestamptz NOT NULL,
  sent_at         timestamptz,
  failed_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX nudge_queue_due_idx ON public.nudge_queue (scheduled_for)
  WHERE sent_at IS NULL AND failed_reason IS NULL;

ALTER TABLE public.nudge_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY nudge_queue_tenant ON public.nudge_queue
  FOR ALL USING (
    client_id IN (SELECT client_id FROM public.client_users WHERE user_id = auth.uid())
  );

GRANT ALL ON public.nudge_queue TO service_role;
