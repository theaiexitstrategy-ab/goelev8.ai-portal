-- Surface the new "Trainer Applications" tab in the Flex Facility portal.
-- The tab itself is defined in app.js + api/portal/trainer-applications.js;
-- this migration just opts the flex-facility tenant in via the per-client
-- portal_tabs jsonb array (the same mechanism used for every other
-- tenant-specific tab). Idempotent — re-running is a no-op.

update public.clients
set portal_tabs = portal_tabs || '["trainer_applications"]'::jsonb
where slug = 'flex-facility'
  and not (portal_tabs ? 'trainer_applications');
