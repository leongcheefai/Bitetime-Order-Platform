alter table public.merchants      enable row level security;
alter table public.products       enable row level security;
alter table public.vouchers       enable row level security;
alter table public.order_counters enable row level security;

-- ── merchants ────────────────────────────────────────────────────────────────
-- Anyone may read a merchant (needed to resolve /s/:slug). Writes: own or super.
drop policy if exists merchants_select_public on public.merchants;
create policy merchants_select_public on public.merchants
  for select using (true);

drop policy if exists merchants_insert_self on public.merchants;
create policy merchants_insert_self on public.merchants
  for insert with check (owner_id = auth.uid());

drop policy if exists merchants_update_own_or_super on public.merchants;
create policy merchants_update_own_or_super on public.merchants
  for update using (owner_id = auth.uid() or public.is_superadmin())
  with check (owner_id = auth.uid() or public.is_superadmin());

-- ── products ─────────────────────────────────────────────────────────────────
-- Public reads ACTIVE products (storefront). Merchant writes own. Super: all.
drop policy if exists products_select_public on public.products;
create policy products_select_public on public.products
  for select using (active or merchant_id = public.current_merchant_id() or public.is_superadmin());

drop policy if exists products_write_own on public.products;
create policy products_write_own on public.products
  for all
  using (merchant_id = public.current_merchant_id() or public.is_superadmin())
  with check (merchant_id = public.current_merchant_id() or public.is_superadmin());

-- ── vouchers ─────────────────────────────────────────────────────────────────
-- Public reads (customer applies a code at checkout). Merchant writes own.
drop policy if exists vouchers_select_public on public.vouchers;
create policy vouchers_select_public on public.vouchers
  for select using (true);

drop policy if exists vouchers_write_own on public.vouchers;
create policy vouchers_write_own on public.vouchers
  for all
  using (merchant_id = public.current_merchant_id() or public.is_superadmin())
  with check (merchant_id = public.current_merchant_id() or public.is_superadmin());

-- ── order_counters ───────────────────────────────────────────────────────────
-- Counter advancement happens through a security-definer RPC (P4); direct table
-- access is owner/super only.
drop policy if exists order_counters_own on public.order_counters;
create policy order_counters_own on public.order_counters
  for all
  using (merchant_id = public.current_merchant_id() or public.is_superadmin())
  with check (merchant_id = public.current_merchant_id() or public.is_superadmin());

-- ── orders (replace single-tenant policies) ──────────────────────────────────
-- Guests still insert (checkout). Reads: the ordering user, the merchant that
-- owns the order, or superadmin. Updates (status/awb/note): merchant or super.
drop policy if exists orders_select_own_or_owner on public.orders;
create policy orders_select_scoped on public.orders
  for select using (
    user_id = auth.uid()
    or merchant_id = public.current_merchant_id()
    or public.is_superadmin()
  );

drop policy if exists orders_update_owner on public.orders;
create policy orders_update_merchant on public.orders
  for update
  using (merchant_id = public.current_merchant_id() or public.is_superadmin())
  with check (merchant_id = public.current_merchant_id() or public.is_superadmin());
-- orders_insert_any (guest checkout) from the baseline is retained.

-- NOTE: profiles block intentionally omitted — handled in 20260627120050_fix_profiles_multitenant.sql
