-- Order courier + public tracking lookup.
-- `courier` holds a short code (jnt/poslaju/ninja/citylink/spx/flash/other) or null;
-- `awb` already exists. Guests cannot read `orders` (RLS is merchant-scoped), so the
-- customer-facing track page reads a non-PII subset through this security-definer RPC.
alter table public.orders add column if not exists courier text;

create or replace function public.track_order(p_merchant uuid, p_order_number text)
returns table (status text, mode text, courier text, awb text, created_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select o.status, o.mode, o.courier, o.awb, o.created_at
  from public.orders o
  where o.merchant_id = p_merchant
    and o.order_number = p_order_number
  limit 1;
$$;

grant execute on function public.track_order(uuid, text) to anon, authenticated;
