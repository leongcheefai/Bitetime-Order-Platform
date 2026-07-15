-- Referral reward ledger (PRD: docs/prd-referral-reward.md, #70).
-- When a merchant that signed up under a member's code pays their FIRST invoice, the
-- referring member earns one month free of their own plan, delivered as a Stripe
-- customer-balance credit. This table is the once-ever record of that grant.
--
-- The primary key is the REFERRED merchant: a shop can grant a reward to its referrer
-- exactly once, ever. Later billing cycles find the row and no-op (idempotency), and a
-- webhook retry after a partial success is safe for the same reason.
--
-- Written only by the Stripe webhook via the service-role key (like merchant_billing):
-- there is no write policy, and the DML grant is withheld from authenticated/anon as a
-- second line of defence.

create table if not exists public.referral_rewards (
  referred_merchant_id  uuid primary key references public.merchants (id) on delete cascade,
  referrer_merchant_id  uuid not null references public.merchants (id) on delete cascade,
  amount                integer not null,        -- credit in the smallest currency unit (cents)
  currency              text    not null,        -- the referrer's subscription currency
  stripe_customer_id    text    not null,        -- the referrer's customer the credit landed on
  stripe_balance_txn_id text,                    -- the customer-balance transaction id
  created_at            timestamptz not null default now()
);

create index if not exists referral_rewards_referrer_idx
  on public.referral_rewards (referrer_merchant_id);

alter table public.referral_rewards enable row level security;

-- A referrer's owner (or a superadmin) may READ the rewards they earned. No write policy:
-- the webhook uses the service-role key, which bypasses RLS. Mirrors merchant_billing.
drop policy if exists referral_rewards_read on public.referral_rewards;
create policy referral_rewards_read on public.referral_rewards
  for select
  using (
    exists (
      select 1 from public.merchants m
      where m.id = referral_rewards.referrer_merchant_id
        and (m.owner_id = auth.uid() or public.is_superadmin())
    )
  );

-- Owners read (gated by the policy above); only service_role writes.
grant select on table public.referral_rewards to authenticated, service_role;
grant insert on table public.referral_rewards to service_role;
