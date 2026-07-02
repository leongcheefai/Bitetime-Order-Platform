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
-- Sets one global profile row (merchant_id NULL); both is_superadmin() and the
-- client role lookup key on profiles.user_id, so this resolves for either path.

do $$
declare
  v_email text := 'bitetime@praxor.dev';   -- <-- edit this
  v_uid   uuid;
begin
  select id into v_uid from auth.users where lower(email) = lower(v_email);
  if v_uid is null then
    raise exception 'No auth user with email %, have they signed up?', v_email;
  end if;

  alter table public.profiles disable trigger guard_profile_privileges;

  -- Profiles are keyed on user_id (id is a surrogate that may differ), so
  -- promote the existing global row by user_id. Fall back to an insert only
  -- when the account has no profile row yet.
  update public.profiles
    set app_role = 'superadmin'
    where user_id = v_uid;

  if not found then
    insert into public.profiles (id, user_id, email, app_role, merchant_id)
      values (v_uid, v_uid, v_email, 'superadmin', null);
  end if;

  alter table public.profiles enable trigger guard_profile_privileges;

  raise notice 'Promoted % (%) to superadmin.', v_email, v_uid;
end $$;
