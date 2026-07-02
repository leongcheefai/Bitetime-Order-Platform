-- Harden merchants.status — the billing enforcement boundary.
-- pending → approval starts the cardless trial; suspended = unpaid. RLS alone
-- (owner_id = auth.uid()) let an owner insert status='active' or flip a suspended
-- shop back to 'active' straight through PostgREST, skipping approval + billing.
--
-- Lock status writes to service_role (the approval endpoint, the Stripe webhooks,
-- and the admin suspend/reactivate endpoint all use it). For everyone else:
--   * INSERT: status is forced to 'pending' (signup can never go live directly)
--   * UPDATE: any attempt to change status raises (owners cannot self-activate,
--     and even a superadmin must go through the service-role backend endpoint)
-- Mirrors public.guard_profile_privileges (20260627120300).
--
-- Note: billing_region stays owner-writable (accepted per issue #24 design).
create or replace function public.guard_merchant_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.status := 'pending';
  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      raise exception 'cannot change merchant status';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_merchant_status on public.merchants;
create trigger guard_merchant_status
  before insert or update on public.merchants
  for each row execute function public.guard_merchant_status();
