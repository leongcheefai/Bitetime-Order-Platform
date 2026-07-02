#!/usr/bin/env bash
# Promote a user to platform super-admin on the LOCAL Supabase dev DB.
#
# Usage: ./scripts/promote-superadmin.sh <email> [docker-db-container]
#   default container: supabase_db_bitetime-app
#
# The account must already exist in auth.users (the person has signed up).
# Briefly disables the guard_profile_privileges trigger for the one write
# (a direct psql connection is neither service_role nor an existing superadmin).
#
# For HOSTED/production Supabase, use scripts/promote_superadmin.sql in the
# Supabase SQL editor instead.
set -euo pipefail

EMAIL="${1:?usage: promote-superadmin.sh <email> [container]}"
CONTAINER="${2:-supabase_db_bitetime-app}"

# Reject anything that isn't a plain email to avoid SQL injection via the arg.
if ! printf '%s' "$EMAIL" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'; then
  echo "error: '$EMAIL' is not a valid email" >&2
  exit 2
fi

docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<SQL
do \$\$
declare
  v_email text := '${EMAIL}';
  v_uid   uuid;
begin
  select id into v_uid from auth.users where lower(email) = lower(v_email);
  if v_uid is null then
    raise exception 'No auth user with email %, have they signed up?', v_email;
  end if;
  alter table public.profiles disable trigger guard_profile_privileges;
  -- Keyed on user_id (id is a surrogate that may differ): promote the existing
  -- global row, insert only when the account has no profile row yet.
  update public.profiles set app_role = 'superadmin' where user_id = v_uid;
  if not found then
    insert into public.profiles (id, user_id, email, app_role, merchant_id)
      values (v_uid, v_uid, v_email, 'superadmin', null);
  end if;
  alter table public.profiles enable trigger guard_profile_privileges;
  raise notice 'Promoted % (%) to superadmin.', v_email, v_uid;
end \$\$;
SQL

echo "Done: ${EMAIL} is now a super-admin."
