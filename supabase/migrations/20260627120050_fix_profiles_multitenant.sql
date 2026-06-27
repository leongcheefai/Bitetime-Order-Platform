-- Fix profiles for per-merchant multi-tenancy.
-- Baseline had profiles.id = auth.users.id (1:1). Restructure to one row per
-- (user_id, merchant_id): id becomes a surrogate key, user_id links the auth user.

alter table public.profiles
  add column if not exists user_id uuid references auth.users (id);

-- Existing rows: their id WAS the auth user id.
update public.profiles set user_id = id where user_id is null;

-- id is no longer the auth user id; drop that FK and give it its own default.
alter table public.profiles drop constraint if exists profiles_id_fkey;
alter table public.profiles alter column id set default gen_random_uuid();

-- Replace the no-op (id, merchant_id) index with real per-tenant uniqueness.
drop index if exists profiles_user_merchant_key;
create unique index if not exists profiles_user_merchant_key
  on public.profiles (user_id, merchant_id)
  where merchant_id is not null;
-- At most one global (no-merchant) profile per user.
create unique index if not exists profiles_user_global_key
  on public.profiles (user_id)
  where merchant_id is null;

-- is_superadmin must match on user_id now (id is a surrogate). Add search_path hygiene.
create or replace function public.is_superadmin()
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.app_role = 'superadmin'
  );
$$;

-- search_path hygiene on the merchant helper too.
create or replace function public.current_merchant_id()
returns uuid
language sql
stable
set search_path = public
as $$
  select m.id from public.merchants m where m.owner_id = auth.uid() limit 1;
$$;

-- Re-point all profiles RLS policies from id to user_id.
drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles
  for insert with check (user_id = auth.uid());

drop policy if exists profiles_update_self_or_owner on public.profiles;
create policy profiles_update_self_or_owner on public.profiles
  for update using (user_id = auth.uid() or public.is_owner() or public.is_superadmin())
  with check (user_id = auth.uid() or public.is_owner() or public.is_superadmin());

drop policy if exists profiles_select_public on public.profiles;
drop policy if exists profiles_select_self_or_super on public.profiles;
create policy profiles_select_self_or_super on public.profiles
  for select using (user_id = auth.uid() or public.is_superadmin());
