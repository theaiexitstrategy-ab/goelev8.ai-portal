-- © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
-- Lead tags normalization.
--
-- Migration 0010 added leads.tags as text[] NOT NULL DEFAULT '{}', which
-- is the shape the app code expects (both the webhook handler in
-- api/events.js and the dashboard lead list in app.js treat tags as an
-- array of strings). At some point during debugging the live database
-- had the column manually ALTER'd to plain text and a bunch of rows
-- landed with JSON-encoded-array strings like '["general"]' in the
-- column. This migration restores the canonical text[] shape and
-- cleans up any legacy rows, regardless of which state the column is
-- currently in.
--
-- Safe to re-run: if the column is already text[] NOT NULL DEFAULT '{}'
-- and no rows need cleanup, this is a no-op.

do $$
declare col_type text;
begin
  select data_type into col_type
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'leads'
      and column_name  = 'tags';

  -- Column missing entirely (shouldn't happen — 0010 adds it — but be
  -- defensive anyway so this migration is self-healing).
  if col_type is null then
    alter table public.leads
      add column tags text[] not null default '{}';
    return;
  end if;

  -- Live DB drifted to plain text. Convert it back to text[], parsing
  -- any JSON-array-looking strings into real arrays and wrapping bare
  -- strings in a single-element array.
  if col_type = 'text' then
    alter table public.leads
      alter column tags drop default;

    alter table public.leads
      alter column tags type text[]
      using case
        when tags is null or tags = ''        then array[]::text[]
        when tags like '[%]'                  then
          (select coalesce(array_agg(value::text), array[]::text[])
             from jsonb_array_elements_text(tags::jsonb) as value)
        else array[tags]
      end;

    alter table public.leads
      alter column tags set default '{}';
    alter table public.leads
      alter column tags set not null;
  end if;
end $$;

-- Rebuild the GIN index in case the column was dropped + recreated above.
drop index if exists public.leads_tags_gin;
create index if not exists leads_tags_gin on public.leads using gin (tags);
