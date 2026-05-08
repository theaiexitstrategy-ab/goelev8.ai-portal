-- Migration 0027: parent client linkage for shared Twilio + credits.
--
-- Use case: Will Power Fitness Factory ships before they have their own
-- Twilio number / SMS credit pool. We want Will's portal to send SMS
-- through The Flex Facility's number (+18775153539) and read/write
-- credits against Flex's balance — but Will keeps his own leads,
-- contacts, bookings, messages, etc.
--
-- Implementation: a self-referential parent_client_id FK. The lib layer
-- resolves the "billing client" by following this pointer. NULL means
-- the client owns its own Twilio + credits (the existing default).
--
-- Idempotent: column add uses IF NOT EXISTS.

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS parent_client_id uuid
    REFERENCES public.clients(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS clients_parent_client_idx
  ON public.clients(parent_client_id)
  WHERE parent_client_id IS NOT NULL;

-- Defense-in-depth: prevent multi-level chains. A parent must not itself
-- be a child. Two-level chains turn lookups into N+1 queries and make
-- "follow the parent" semantics ambiguous (does Will → Flex → Goelev8
-- bill against Flex or Goelev8?). We require parent_client_id to point
-- at a client whose own parent_client_id is NULL.
CREATE OR REPLACE FUNCTION public.check_parent_client_no_chain()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_parent_of_parent uuid;
BEGIN
  IF NEW.parent_client_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.parent_client_id = NEW.id THEN
    RAISE EXCEPTION 'A client cannot be its own parent';
  END IF;
  SELECT parent_client_id INTO v_parent_of_parent
    FROM public.clients WHERE id = NEW.parent_client_id;
  IF v_parent_of_parent IS NOT NULL THEN
    RAISE EXCEPTION 'parent_client_id must point at a top-level client (no chains)';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS clients_parent_no_chain ON public.clients;
CREATE TRIGGER clients_parent_no_chain
  BEFORE INSERT OR UPDATE OF parent_client_id ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.check_parent_client_no_chain();
