-- supabase/migrations/20260720130000_fulfilment_date.sql
-- Fulfilment date selection (#91). Customers pick the date they want their order on.

-- The shop's clock. Which date is "today" — and therefore which date is the earliest a
-- customer may pick — is a property of the SHOP, not of the device ordering from it. A
-- column rather than a key in `config` because order intake reads it on every single order
-- and it is not optional.
alter table public.merchants
  add column if not exists timezone text not null default 'Asia/Kuala_Lumpur';

-- The date the customer asked for.
--
-- NULLABLE, and it stays nullable: every order placed before this shipped has no date and
-- never will. "Required" is enforced at intake for NEW orders (apps/backend/src/orders.ts),
-- which is the only place that can tell a new order from an old row. A NOT NULL here would
-- have to invent a date for history, and an invented fulfilment date is worse than none.
alter table public.orders
  add column if not exists fulfil_date date;

-- The single-tenant baseline shipped `preferred_date` and nothing ever wrote or read it.
-- Dropped rather than reused: the name reads as a soft wish, and this column is a
-- commitment the shop schedules against.
alter table public.orders
  drop column if exists preferred_date;

-- The merchant dashboard's natural question is "what is due, soonest first", per shop.
create index if not exists orders_merchant_fulfil_date_idx
  on public.orders (merchant_id, fulfil_date);

comment on column public.merchants.timezone is
  'IANA zone deciding the shop''s "today" for fulfilment date windows. Validated on write by pickMerchantConfig.';
comment on column public.orders.fulfil_date is
  'Date the customer asked for. NULL only on orders placed before #91 shipped.';
