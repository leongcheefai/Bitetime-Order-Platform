-- A promo price on a product, with an optional end date and an optional quantity cap.
--
-- promo_end is a timestamptz — an ABSOLUTE INSTANT, never a local date. The pricing rule runs on
-- BOTH sides of the wire (the browser quotes, the backend charges, and a disagreement is refused
-- outright), and `new Date('2026-07-20' + 'T23:59:59')` parses as LOCAL time: a UTC server and a
-- UTC+8 customer would resolve one stored string to instants eight hours apart, and refuse every
-- promo checkout on the promo's last day. See #69.

alter table public.products
  add column promo_price numeric,      -- null = no promo. 0 is a VALID promo (a free item).
  add column promo_limit int,          -- null = uncapped
  add column promo_end   timestamptz,  -- null = no end date
  add column promo_sold  int not null default 0;

alter table public.products
  add constraint products_promo_price_nonneg
    check (promo_price is null or promo_price >= 0),
  -- A "promo" above the base price is not a promo. The dashboard checks this too; the dashboard
  -- is not the only thing that can write this row.
  add constraint products_promo_below_price
    check (promo_price is null or promo_price < price),
  add constraint products_promo_limit_positive
    check (promo_limit is null or promo_limit > 0);

create or replace function public.products_promo_sold_guard() returns trigger
language plpgsql as $$
begin
  -- A counter the client can write is not a counter — the same rule that governs orders.user_id
  -- and the voucher's one-per-customer key.
  --
  -- The dashboard upserts the WHOLE product row. A merchant editing a product's NAME while a
  -- customer is checking out would write back a promo_sold it read before the sale, silently
  -- rewinding the cap. The browser's roles cannot move this column at all; only the backend's
  -- owner connection, holding the row lock, can. Pinned silently rather than raised: this is a
  -- backstop against a race, not a dashboard bug to report.
  if current_user in ('authenticated', 'anon') then
    new.promo_sold := coalesce(old.promo_sold, 0);
  end if;

  -- A new promo PRICE is a new promo, and its cap starts empty. Raising the cap of a RUNNING
  -- promo does not reset it: 10 sold against a cap of 10, cap raised to 20, means ten more units
  -- — not twenty. The number the merchant types is the number that sells, ever.
  if tg_op = 'UPDATE' and new.promo_price is distinct from old.promo_price then
    new.promo_sold := 0;
  end if;

  return new;
end $$;

drop trigger if exists products_promo_sold_guard on public.products;
create trigger products_promo_sold_guard
  before insert or update on public.products
  for each row execute function public.products_promo_sold_guard();

-- Without this, PostgREST 404s on the new columns until it restarts.
notify pgrst, 'reload schema';
