-- Add jsonb payload column to leads. findOrUpsertLead (lib/lead-dedupe.js)
-- conditionally sets insertRow.payload when the caller passes the raw event
-- body through (events.js does this on every cross-project ingest). Without
-- this column the insert 400s on "Could not find the 'payload' column",
-- and the retry-on-missing-column path doesn't match PostgREST's error
-- format, so the lead silently never lands in the leads table.

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS payload jsonb;

-- Index on (client_id, created_at) is already in place from earlier
-- migrations; no new index needed for payload — it's read alongside the
-- row, not queried.
