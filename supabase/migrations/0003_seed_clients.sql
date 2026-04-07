-- Onboard Flex Facility + iSlay Studios in one shot.
-- Run this in the Supabase SQL Editor AFTER 0001_init.sql and 0002_twilio_subaccounts.sql.
--
-- Creates:
--   • 2 clients rows
--   • 4 auth.users (with bcrypt passwords)
--   • 4 client_users mappings

-- ============================================================
-- 1. Clients
-- ============================================================
insert into public.clients (slug, name, twilio_phone_number, credit_balance)
values
  ('flex-facility', 'The Flex Facility', '+18775153539', 0),
  ('islay-studios', 'iSlay Studios',     '+18332787529', 0)
on conflict (slug) do update
  set name = excluded.name,
      twilio_phone_number = excluded.twilio_phone_number;

-- ============================================================
-- 2. Auth users + client_users links
-- ============================================================
do $$
declare
  flex_id   uuid;
  islay_id  uuid;

  -- (email, password, client_slug)
  rec record;
  uid uuid;
begin
  select id into flex_id  from public.clients where slug = 'flex-facility';
  select id into islay_id from public.clients where slug = 'islay-studios';

  for rec in
    select * from (values
      ('ab@theflexfacility.com',    'Flex123!!!',  flex_id),
      ('kenny@theflexfacility.com', 'Flex123!!!',  flex_id),
      ('ab@islaystudiosllc.com',    'iSlay123!!!', islay_id),
      ('nate@islaystudiosllc.com',  'iSlay123!!!', islay_id)
    ) as t(email, password, client_id)
  loop
    -- Does the user already exist?
    select id into uid from auth.users where email = rec.email;

    if uid is null then
      uid := gen_random_uuid();
      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data,
        is_super_admin, confirmation_token, email_change, email_change_token_new, recovery_token
      ) values (
        '00000000-0000-0000-0000-000000000000',
        uid,
        'authenticated',
        'authenticated',
        rec.email,
        crypt(rec.password, gen_salt('bf')),
        now(), now(), now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        '{}'::jsonb,
        false, '', '', '', ''
      );
      insert into auth.identities (
        id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
      ) values (
        gen_random_uuid(),
        uid,
        jsonb_build_object('sub', uid::text, 'email', rec.email, 'email_verified', true),
        'email',
        rec.email,
        now(), now(), now()
      );
    else
      -- User exists — reset password to known value
      update auth.users
         set encrypted_password = crypt(rec.password, gen_salt('bf')),
             email_confirmed_at = coalesce(email_confirmed_at, now()),
             updated_at = now()
       where id = uid;
    end if;

    insert into public.client_users (user_id, client_id, role)
    values (uid, rec.client_id, 'owner')
    on conflict (user_id) do update set client_id = excluded.client_id;
  end loop;
end $$;

-- Verify
select c.name as client, u.email
  from public.client_users cu
  join public.clients c    on c.id = cu.client_id
  join auth.users u        on u.id = cu.user_id
 order by c.name, u.email;
