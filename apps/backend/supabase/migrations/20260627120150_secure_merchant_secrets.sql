-- Move Telegram credentials out of the publicly-readable merchants table.
create table if not exists public.merchant_secrets (
  merchant_id uuid primary key references public.merchants (id) on delete cascade,
  tg_token    text,
  tg_chat_id  text
);

-- Fresh start: drop the exposed columns from merchants.
alter table public.merchants drop column if exists tg_token;
alter table public.merchants drop column if exists tg_chat_id;

alter table public.merchant_secrets enable row level security;

-- Only the owning merchant or a superadmin may read/write secrets.
drop policy if exists merchant_secrets_own on public.merchant_secrets;
create policy merchant_secrets_own on public.merchant_secrets
  for all
  using (
    exists (
      select 1 from public.merchants m
      where m.id = merchant_secrets.merchant_id
        and (m.owner_id = auth.uid() or public.is_superadmin())
    )
  )
  with check (
    exists (
      select 1 from public.merchants m
      where m.id = merchant_secrets.merchant_id
        and (m.owner_id = auth.uid() or public.is_superadmin())
    )
  );

-- Break the profiles<->is_superadmin RLS recursion: run as definer so the
-- profiles read inside is_superadmin bypasses RLS.
create or replace function public.is_superadmin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.app_role = 'superadmin'
  );
$$;
