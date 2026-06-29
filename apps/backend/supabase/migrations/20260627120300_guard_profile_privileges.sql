-- Prevent privilege escalation: only superadmin or service_role may set/change
-- app_role or merchant_id on profiles. Self-service writes are forced to customer
-- and cannot elevate role or re-bind tenant.
create or replace function public.guard_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if public.is_superadmin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.app_role := 'customer';
  elsif tg_op = 'UPDATE' then
    if new.app_role is distinct from old.app_role then
      raise exception 'cannot change app_role';
    end if;
    if new.merchant_id is distinct from old.merchant_id then
      raise exception 'cannot change merchant_id';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_profile_privileges on public.profiles;
create trigger guard_profile_privileges
  before insert or update on public.profiles
  for each row execute function public.guard_profile_privileges();
