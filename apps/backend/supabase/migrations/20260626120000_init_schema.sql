-- ============================================================================
-- Bitetime & Co. — initial schema
-- ============================================================================
-- TABLE DDL below is RECONCILED against a live schema dump (verified 2026-06-26):
-- columns, types, keys and constraints match production exactly.
--
-- RLS POLICIES and the two RPCs (product_sales, is_new_customer) were NOT in
-- that dump — they are still INFERRED from application behavior and flagged ⚠.
-- Confirm them against production with:
--     supabase db dump --schema public > live.sql     # includes policies + functions
--
-- RLS stance: FAITHFUL to current live behavior. The app performs anonymous
-- (guest) WRITES to `settings` during guest checkout — order counter, voucher
-- `usedBy`, and referral rewards are upserted by unauthenticated clients. Those
-- permissive policies are reproduced here and flagged ⚠. Known security smell:
-- any anonymous user can overwrite any settings row.
--
-- KNOWN CODE/DB DRIFT (do not "fix" silently — confirm intent first):
--   • store.js writes/reads profiles.delivery_address, but that column does NOT
--     exist in production. The DB upsert errors; saved addresses live only in
--     localStorage. Either add the column (uncomment below) or drop the code.
--   • orders.order_number is a plain nullable, NON-UNIQUE text column in prod,
--     yet the app treats it as a lookup key (status map, updateOrderUser).
--     Uniqueness is only guaranteed by getNextOrderNumber()'s daily counter.
-- ============================================================================

-- Owner gate: the single admin account, matched on the JWT email claim.
-- Mirrors USER_EMAIL in App.jsx. (Inferred helper — not in the live dump.)
create or replace function public.is_owner()
returns boolean
language sql
stable
as $$
  select coalesce(auth.jwt() ->> 'email', '') = 'bitetimeandco@gmail.com';
$$;

-- ── profiles ────────────────────────────────────────────────────────────────
-- One row per auth user. id mirrors auth.users.id.
create table if not exists public.profiles (
  id              uuid not null,
  name            text,
  email           text,
  created_at      timestamptz default now(),
  email_confirmed boolean default false,
  referral_code   text unique,                          -- first 8 hex of id, uppercased
  -- ⚠ delivery_address: referenced by store.js but ABSENT in production.
  --   Uncomment to bring the DB in line with the code:
  -- delivery_address jsonb,
  constraint profiles_pkey primary key (id),
  constraint profiles_id_fkey foreign key (id) references auth.users (id)
);

-- ── orders ──────────────────────────────────────────────────────────────────
-- Order status / AWB / notes are NOT columns — they live in the settings
-- key-value table (keys: order_statuses, order_awb, order_notes), keyed by
-- order_number. There is also no delivery_slot column; the same-day slot is
-- appended into `address` (see OrderForm.jsx).
create table if not exists public.orders (
  id             uuid not null default gen_random_uuid(),
  created_at     timestamptz default now(),
  user_id        uuid,                                  -- null for guest orders
  customer_name  text,
  customer_wa    text,
  preferred_date date,                                  -- null when not applicable
  mode           text,                                  -- 'pickup' | 'delivery' | 'sameday'
  address        text,                                  -- null for pickup; slot appended for sameday
  region         text,                                  -- 'WM' | 'EM' | null
  shipping_fee   numeric,
  items          jsonb,                                 -- [{id,name,qty,price}, ...]
  total          numeric,
  order_number   text,                                  -- BT-YYMMDD-NNNN (nullable, NOT unique in prod)
  referrer_code  text,                                  -- referral code used at checkout, or null
  constraint orders_pkey primary key (id),
  constraint orders_user_id_fkey foreign key (user_id) references auth.users (id)
);

-- ── settings ────────────────────────────────────────────────────────────────
-- Generic key-value store. Known keys:
--   main, order_statuses, order_awb, order_notes, order_counter,
--   vouchers, referral_rewards
create table if not exists public.settings (
  key        text not null,
  value      jsonb not null,
  updated_at timestamptz default now(),
  constraint settings_pkey primary key (key)
);

-- ============================================================================
-- RPCs (security definer) — ⚠ INFERRED, not in the live dump.
-- Let GUESTS read order-derived data without direct read access to orders.
-- ============================================================================

-- Flattens every order line item into rows: one per item, with the order time.
-- Used by promo quantity limits (fetchProductSales).
create or replace function public.product_sales()
returns table (id text, qty numeric, at timestamptz)
language sql
security definer
set search_path = public
as $$
  select
    item ->> 'id'                          as id,
    coalesce((item ->> 'qty')::numeric, 0) as qty,
    o.created_at                           as at
  from public.orders o,
       lateral jsonb_array_elements(coalesce(o.items, '[]'::jsonb)) as item
  where item ->> 'id' is not null;
$$;

-- True when no past order matches this WhatsApp number OR this account email.
-- Email is matched via the profiles join (orders has no email column).
create or replace function public.is_new_customer(p_wa text, p_email text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select not exists (
    select 1
    from public.orders o
    left join public.profiles p on p.id = o.user_id
    where (p_wa    <> '' and o.customer_wa = p_wa)
       or (p_email <> '' and lower(p.email) = lower(p_email))
  );
$$;

grant execute on function public.product_sales()            to anon, authenticated;
grant execute on function public.is_new_customer(text, text) to anon, authenticated;
grant execute on function public.is_owner()                 to anon, authenticated;

-- ============================================================================
-- Row Level Security — ⚠ INFERRED, not in the live dump. Verify before trusting.
-- ============================================================================
alter table public.profiles enable row level security;
alter table public.orders   enable row level security;
alter table public.settings enable row level security;

-- ── profiles policies ────────────────────────────────────────────────────────
-- ⚠ Guests look up the referrer profile by referral_code (and email) via direct
--   selects, so SELECT is open to everyone. This EXPOSES profile rows (incl.
--   email) to anonymous clients. Harden by moving referral lookup into a
--   security-definer RPC returning only { id } and dropping this policy.
drop policy if exists profiles_select_public on public.profiles;
create policy profiles_select_public on public.profiles
  for select using (true);

drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles
  for insert with check (id = auth.uid());

drop policy if exists profiles_update_self_or_owner on public.profiles;
create policy profiles_update_self_or_owner on public.profiles
  for update using (id = auth.uid() or public.is_owner())
  with check (id = auth.uid() or public.is_owner());

-- ── orders policies ──────────────────────────────────────────────────────────
drop policy if exists orders_insert_any on public.orders;
create policy orders_insert_any on public.orders
  for insert with check (true);                          -- guest checkout

drop policy if exists orders_select_own_or_owner on public.orders;
create policy orders_select_own_or_owner on public.orders
  for select using (user_id = auth.uid() or public.is_owner());

drop policy if exists orders_update_owner on public.orders;
create policy orders_update_owner on public.orders
  for update using (public.is_owner())
  with check (public.is_owner());                        -- re-link / edits: owner

-- ── settings policies ────────────────────────────────────────────────────────
drop policy if exists settings_select_public on public.settings;
create policy settings_select_public on public.settings
  for select using (true);

-- ⚠ Public write: guest checkout upserts order_counter, vouchers (usedBy) and
--   referral_rewards as an ANONYMOUS client — so any anon user can overwrite ANY
--   settings row. Reproduced to match the live app. Harden by replacing these
--   client upserts with narrow security-definer RPCs and restricting direct
--   writes to the owner.
drop policy if exists settings_insert_public on public.settings;
create policy settings_insert_public on public.settings
  for insert with check (true);

drop policy if exists settings_update_public on public.settings;
create policy settings_update_public on public.settings
  for update using (true) with check (true);
