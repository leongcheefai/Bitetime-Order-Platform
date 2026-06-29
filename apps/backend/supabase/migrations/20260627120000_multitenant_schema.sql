-- supabase/migrations/20260627120000_multitenant_schema.sql
-- Multi-tenant foundation. Additive on top of the single-tenant baseline.

-- ── merchants ────────────────────────────────────────────────────────────────
create table if not exists public.merchants (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  slug         text not null unique,
  order_prefix text not null,
  status       text not null default 'pending'
               check (status in ('pending','active','suspended')),
  -- payment + notification config, per merchant (manual payment model)
  payment_qr   text,
  payment_bank text,
  payment_note text,
  tg_token     text,
  tg_chat_id   text,
  -- store config previously held in settings.main, now per merchant
  shipping     jsonb not null default '{"WM":8,"EM":18}'::jsonb,
  config       jsonb not null default '{}'::jsonb,   -- sameday, pickup, leadDays, availableDays, blockedDates
  slug_locked  boolean not null default false,        -- editable once, then true
  owner_id     uuid references auth.users (id),       -- the merchant admin account
  created_at   timestamptz not null default now()
);

-- ── role on profiles ─────────────────────────────────────────────────────────
-- 'customer' (default) | 'merchant' | 'superadmin'
alter table public.profiles
  add column if not exists app_role text not null default 'customer'
    check (app_role in ('customer','merchant','superadmin'));

-- Per-merchant customer profiles: one row per (user_id, merchant_id).
-- profiles.id stays the surrogate; we add the tenant link and a uniqueness rule.
alter table public.profiles
  add column if not exists merchant_id uuid references public.merchants (id);

-- A given auth user has at most one profile per merchant.
create unique index if not exists profiles_user_merchant_key
  on public.profiles (id, merchant_id)
  where merchant_id is not null;

-- ── tenant scoping on orders ─────────────────────────────────────────────────
alter table public.orders
  add column if not exists merchant_id uuid references public.merchants (id);
create index if not exists orders_merchant_id_idx on public.orders (merchant_id);

-- Order status / AWB / notes move off the settings blob onto orders.
alter table public.orders
  add column if not exists status text default 'new';
alter table public.orders
  add column if not exists awb text;
alter table public.orders
  add column if not exists note text;

-- order_number is unique PER MERCHANT (not globally).
drop index if exists orders_order_number_key;
create unique index if not exists orders_merchant_order_number_key
  on public.orders (merchant_id, order_number)
  where order_number is not null;

-- ── products ─────────────────────────────────────────────────────────────────
create table if not exists public.products (
  id          uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id),
  name        text not null,
  name_zh     text,
  descr       text,
  descr_zh    text,
  price       numeric not null default 0,
  unit        text,
  sort        int not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists products_merchant_id_idx on public.products (merchant_id);

-- ── vouchers ─────────────────────────────────────────────────────────────────
create table if not exists public.vouchers (
  id          uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id),
  code        text not null,
  kind        text,                                   -- percent | fixed | etc.
  amount      numeric,
  max_uses    int,                                    -- null = unlimited total (still 1/customer)
  used_by     jsonb not null default '[]'::jsonb,     -- list of emails / guest tokens
  created_at  timestamptz not null default now(),
  unique (merchant_id, code)
);
create index if not exists vouchers_merchant_id_idx on public.vouchers (merchant_id);

-- ── per-merchant order counter ───────────────────────────────────────────────
create table if not exists public.order_counters (
  merchant_id uuid primary key references public.merchants (id),
  day         text,                                   -- 'YYMMDD'
  value       int not null default 50
);

-- ── helper: the merchant the current user administers ─────────────────────────
create or replace function public.current_merchant_id()
returns uuid
language sql
stable
as $$
  select m.id from public.merchants m where m.owner_id = auth.uid() limit 1;
$$;

create or replace function public.is_superadmin()
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.app_role = 'superadmin'
  );
$$;

grant execute on function public.current_merchant_id() to anon, authenticated;
grant execute on function public.is_superadmin()       to anon, authenticated;
