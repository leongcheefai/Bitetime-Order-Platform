-- Promote a user to platform super-admin (real, DB-enforced app_role).
--
-- Why this is needed: the guard_profile_privileges trigger blocks anyone except
-- service_role / an existing super-admin from setting profiles.app_role. A direct
-- SQL connection (Supabase SQL editor, psql) is neither, so we briefly disable the
-- trigger for this one write, then re-enable it.
--
-- Usage (Supabase SQL editor or psql, runs as the postgres role):
--   1. Edit v_email below to the target account's email.
--   2. Run the whole block.
-- The account must already exist in auth.users (i.e. the person has signed up).
--
-- Sets one global profile row (merchant_id NULL) so both is_superadmin() (matches
-- profiles.user_id) and the client role lookup (matches profiles.id) resolve.

do $$
declare
  v_email text := 'CHANGE_ME@example.com';   -- <-- edit this
  v_uid   uuid;
begin
  select id into v_uid from auth.users where lower(email) = lower(v_email);
  if v_uid is null then
    raise exception 'No auth user with email %, have they signed up?', v_email;
  end if;

  alter table public.profiles disable trigger guard_profile_privileges;

  insert into public.profiles (id, user_id, email, app_role, merchant_id)
    values (v_uid, v_uid, v_email, 'superadmin', null)
  on conflict (id) do update
    set app_role = 'superadmin', user_id = v_uid;

  alter table public.profiles enable trigger guard_profile_privileges;

  raise notice 'Promoted % (%) to superadmin.', v_email, v_uid;
end $$;
