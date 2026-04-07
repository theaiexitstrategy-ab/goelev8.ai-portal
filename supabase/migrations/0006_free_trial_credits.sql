-- Free trial: every new client starts with 20 SMS credits.
-- Existing clients with no usage history also get the grant, exactly once.

-- 1. New clients default to 20 credits going forward.
alter table public.clients
  alter column credit_balance set default 20;

-- 2. Backfill existing clients that have never received the trial grant
--    AND have a balance <= 20 (so we don't top up clients who already
--    bought credits). Uses a single ledger row as the idempotency key.
do $$
declare
  r record;
begin
  for r in
    select c.id
      from public.clients c
     where not exists (
        select 1 from public.credit_ledger l
         where l.client_id = c.id and l.reason = 'trial_grant'
     )
       and coalesce(c.credit_balance, 0) <= 20
  loop
    perform public.add_credits(r.id, 20);
    insert into public.credit_ledger (client_id, delta, reason, ref_id)
      values (r.id, 20, 'trial_grant', 'free_trial_20');
  end loop;
end $$;
