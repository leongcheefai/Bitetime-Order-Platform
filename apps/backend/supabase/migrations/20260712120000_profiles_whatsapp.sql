-- A customer types their WhatsApp number and delivery address once, ever.
--
-- `profiles.delivery_address` already exists (added by the drift fix in
-- 20260626120200) but nothing has ever read or written it. The phone number has
-- no home at all: `orders.customer_wa` records the number used for one order,
-- which is a fact about that order, not about the customer.
--
-- Both live on the GLOBAL profile (merchant_id is null), not a per-shop one:
-- an address is an address. Retyping it at every new shop is exactly the tax
-- this removes.
alter table public.profiles
  add column if not exists whatsapp text;

-- No backfill from orders.customer_wa. A number typed into a guest order is not
-- a claim about who owns it, and the orders that DO carry a user_id predate this
-- column by days — the customer will refill it on their next order at no cost.
--
-- RLS needs no change: profiles_update_self_or_owner already lets a user write
-- their own row, and profiles_select_self_or_super already lets them read it.
-- Nobody else can see either column.
