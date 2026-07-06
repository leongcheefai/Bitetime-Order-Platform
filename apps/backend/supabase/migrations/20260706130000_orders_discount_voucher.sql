-- Persist the checkout discount and the voucher code that produced it.
-- Without these, a discounted order stored only its net total, so the merchant
-- order detail showed items + shipping that didn't reconcile to the total and
-- gave no hint a voucher was used.
alter table public.orders
  add column if not exists discount     numeric,   -- amount taken off (>= 0), null/0 = none
  add column if not exists voucher_code text;       -- code applied at checkout, or null
