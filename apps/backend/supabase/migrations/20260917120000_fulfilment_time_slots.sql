-- supabase/migrations/20260917120000_fulfilment_time_slots.sql
--
-- The slot the customer picked (#282), stored as BOTH ends. Not a start plus the shop's
-- `slot_minutes`: the merchant may change the slot length later, and the order records what the
-- customer was promised. Null on both means "placed with no slot" — before this feature, or at a
-- shop with slots off — the same rule `fulfil_date` uses for its null.
alter table public.orders
  add column if not exists fulfil_time_from time,
  add column if not exists fulfil_time_to time;

alter table public.orders
  drop constraint if exists orders_fulfil_time_pair;
alter table public.orders
  add constraint orders_fulfil_time_pair check (
    (fulfil_time_from is null and fulfil_time_to is null)
    or (fulfil_time_from is not null and fulfil_time_to is not null and fulfil_time_to > fulfil_time_from)
  );

comment on column public.orders.fulfil_time_from is
  'Start of the slot the customer picked, shop-local wall clock. Null: placed with no slot.';
comment on column public.orders.fulfil_time_to is
  'End of the slot the customer picked. Stored, not derived, so a later slot_minutes change does not rewrite history.';
