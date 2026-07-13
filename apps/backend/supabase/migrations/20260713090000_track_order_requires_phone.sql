-- Tracking a guest order now costs an order number AND the phone that placed it.
--
-- Order numbers are a per-shop daily counter (`VE-20260713-0001`), so the old two-argument
-- `track_order` — granted to `anon`, matching on the number alone — let anyone walk a shop's
-- day and read back every order's status and AWB. No PII in the return, but an AWB is a live
-- parcel handle on the courier's own site.
--
-- `customer_wa` is required at checkout and already stored on every order, so the second factor
-- needs no new column and no backfill: orders placed before this migration keep working.
-- Guessing the number now also means guessing ~8 digits of phone, which over HTTP is the end of it.
create or replace function public.track_order(
  p_merchant uuid,
  p_order_number text,
  p_phone text
)
returns table (status text, mode text, courier text, awb text, created_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select o.status, o.mode, o.courier, o.awb, o.created_at
  from public.orders o
  where o.merchant_id = p_merchant
    and o.order_number = p_order_number
    -- Digits only, last 8: the same human typing the same phone as `+60 12-345 6789`, `0123456789`
    -- or `60123456789` must match every time. A raw string compare would lock customers out of
    -- their own orders far more often than it would stop anyone.
    and right(regexp_replace(coalesce(o.customer_wa, ''), '\D', '', 'g'), 8)
      = right(regexp_replace(coalesce(p_phone, ''),      '\D', '', 'g'), 8)
    -- An order with no phone on file must never match the empty string both sides normalise to.
    and coalesce(regexp_replace(coalesce(o.customer_wa, ''), '\D', '', 'g'), '') <> ''
  limit 1;
$$;

-- The whole point. Leaving the phone-less overload granted to `anon` would keep the door it opens
-- wide open right next to the one being shut.
drop function if exists public.track_order(uuid, text);

grant execute on function public.track_order(uuid, text, text) to anon, authenticated;
