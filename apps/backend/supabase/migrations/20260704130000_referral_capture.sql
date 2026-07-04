-- Referral capture & track (spec: docs/superpowers/specs/2026-07-04-referral-capture-track-design.md)
-- Records which referral code a new merchant signed up under, and lets a referrer
-- list the shops that used their code. Display-only — no reward logic.

alter table public.merchants
  add column if not exists referred_by_code text;

create index if not exists merchants_referred_by_code_idx
  on public.merchants (referred_by_code);

-- Returns the shops that signed up with the CALLER's own referral code. The caller's
-- code is derived from auth.uid() in SQL exactly as referralCodeOf() does in the app
-- (strip dashes, first 8 hex chars, uppercase). SECURITY DEFINER so it can read across
-- tenants, but it only ever returns rows matching the caller's code and only three
-- non-sensitive columns.
create or replace function public.my_referred_shops()
returns table (name text, created_at timestamptz, status text)
language sql
security definer
set search_path = public
as $$
  select m.name, m.created_at, m.status::text
  from public.merchants m
  where m.referred_by_code = upper(left(replace(auth.uid()::text, '-', ''), 8))
  order by m.created_at desc;
$$;

grant execute on function public.my_referred_shops() to authenticated;
