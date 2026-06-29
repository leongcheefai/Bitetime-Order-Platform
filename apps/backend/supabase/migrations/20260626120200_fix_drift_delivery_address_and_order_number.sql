-- ============================================================================
-- Close the two code/DB drifts (see 20260626120000_init_schema.sql header).
-- Forward migration: applied ON TOP of the live baseline.
-- ============================================================================

-- 1) profiles.delivery_address — store.js already writes/reads this jsonb
--    ({line1,line2,city,postcode,state}); the column was missing in prod, so
--    those upserts silently errored and addresses lived only in localStorage.
alter table public.profiles
  add column if not exists delivery_address jsonb;

-- 2) orders.order_number uniqueness — the app keys status/AWB/notes maps and
--    updateOrderUser() on order_number, but prod had no constraint guaranteeing
--    it. getNextOrderNumber()'s daily counter makes collisions unlikely, not
--    impossible. A PARTIAL unique index enforces it while still allowing the
--    NULLs that legacy guest rows may carry.
--
--    ⚠ If duplicate order_numbers already exist this will FAIL. Check first:
--        select order_number, count(*)
--        from public.orders
--        where order_number is not null
--        group by order_number having count(*) > 1;
--    Resolve any duplicates before applying.
create unique index if not exists orders_order_number_key
  on public.orders (order_number)
  where order_number is not null;
