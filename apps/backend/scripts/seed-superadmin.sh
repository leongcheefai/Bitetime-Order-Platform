#!/usr/bin/env bash
# Seed a platform super-admin on the LOCAL Supabase dev DB.
#
# Usage: ./scripts/seed-superadmin.sh [email] [password] [docker-db-container]
#   email     super-admin account (default: bitetime@praxor.dev)
#   password  dev login password   (default: superadmin123)
#   container default: supabase_db_bitetime-app
#
# Unlike promote-superadmin.sh (which only flips app_role on an account that has
# ALREADY signed up), this creates the auth.users row first when it is missing —
# so it works from a clean DB after `supabase db reset` / a `test:db` run, which
# wipe every account. Idempotent: re-running leaves an existing account as-is and
# just re-asserts the superadmin role.
#
# For HOSTED/production Supabase, use scripts/promote_superadmin.sql instead.
set -euo pipefail

EMAIL="${1:-bitetime@praxor.dev}"
PASSWORD="${2:-123456}"
CONTAINER="${3:-supabase_db_bitetime-app}"

# Reject anything that isn't a plain email to avoid SQL injection via the arg.
if ! printf '%s' "$EMAIL" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'; then
  echo "error: '$EMAIL' is not a valid email" >&2
  exit 2
fi

docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -v email="$EMAIL" -v password="$PASSWORD" <<'SQL'
-- psql :'var' substitution does NOT reach inside a $$ dollar-quoted block, so
-- stash the args as session settings here (interpolated as proper literals by
-- psql, no injection) and read them back inside the DO block.
select set_config('seed.email', :'email', false),
       set_config('seed.password', :'password', false);
do $$
declare
  v_email text := current_setting('seed.email');
  v_pass  text := current_setting('seed.password');
  v_uid   uuid;
begin
  select id into v_uid from auth.users where lower(email) = lower(v_email);

  -- Create the auth account (email pre-confirmed) when it does not exist yet.
  if v_uid is null then
    v_uid := gen_random_uuid();
    insert into auth.users
      (instance_id, id, aud, role, email, encrypted_password,
       email_confirmed_at, created_at, updated_at,
       raw_app_meta_data, raw_user_meta_data)
    values
      ('00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated',
       v_email, crypt(v_pass, gen_salt('bf')),
       now(), now(), now(),
       '{"provider":"email","providers":["email"]}', '{}');
    insert into auth.identities
      (id, user_id, provider_id, identity_data, provider,
       last_sign_in_at, created_at, updated_at)
    values
      (gen_random_uuid(), v_uid, v_uid::text,
       jsonb_build_object('sub', v_uid::text, 'email', v_email),
       'email', now(), now(), now());
    raise notice 'Created auth user % (%).', v_email, v_uid;
  else
    raise notice 'Auth user % already exists (%).', v_email, v_uid;
  end if;

  -- Promote to super-admin. The guard_profile_privileges trigger blocks a plain
  -- psql connection from setting app_role, so disable it for this one write.
  alter table public.profiles disable trigger guard_profile_privileges;
  update public.profiles set app_role = 'superadmin' where user_id = v_uid;
  if not found then
    insert into public.profiles (id, user_id, email, app_role, merchant_id)
      values (v_uid, v_uid, v_email, 'superadmin', null);
  end if;
  alter table public.profiles enable trigger guard_profile_privileges;

  raise notice 'Promoted % to superadmin.', v_email;
end $$;
SQL

echo "Done: ${EMAIL} is a super-admin (password: ${PASSWORD})."
