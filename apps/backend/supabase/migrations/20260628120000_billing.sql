-- Billing / Stripe subscriptions.
-- Plan intent lives on merchants (owner-writable, just the chosen plan for display
-- and checkout retry). Authoritative subscription state lives in merchant_billing,
-- which is written only by the Stripe webhook via the service-role key.

-- ── Plan intent on merchants (owner-writable) ──────────────────────────────────
alter table public.merchants
  add column if not exists plan          text check (plan in ('basic','pro')),
  add column if not exists billing_cycle text check (billing_cycle in ('monthly','yearly'));

-- ── Authoritative subscription state (service-role write, owner read) ───────────
create table if not exists public.merchant_billing (
  merchant_id            uuid primary key references public.merchants (id) on delete cascade,
  stripe_customer_id     text,
  stripe_subscription_id text,
  status                 text check (status in ('trialing','active','past_due','canceled','incomplete')),
  trial_ends_at          timestamptz,
  current_period_end     timestamptz,
  updated_at             timestamptz not null default now()
);

alter table public.merchant_billing enable row level security;

-- Owner or superadmin may READ their billing row. There is no write policy: the
-- webhook uses the service-role key, which bypasses RLS. (Mirrors merchant_secrets.)
drop policy if exists merchant_billing_read on public.merchant_billing;
create policy merchant_billing_read on public.merchant_billing
  for select
  using (
    exists (
      select 1 from public.merchants m
      where m.id = merchant_billing.merchant_id
        and (m.owner_id = auth.uid() or public.is_superadmin())
    )
  );

-- Table grants: owners read, only service_role writes. Even without a write policy,
-- withholding the DML grant from authenticated/anon is a second line of defense.
grant select on table public.merchant_billing to authenticated, service_role;
grant insert, update, delete on table public.merchant_billing to service_role;
