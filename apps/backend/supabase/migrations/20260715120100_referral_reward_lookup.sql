-- Reward lookup support (PRD: docs/prd-referral-reward.md, #70).
--
-- 1. One shop per member, ENFORCED. The whole app already assumes it — every owner_id
--    lookup is `.maybeSingle()`, which throws on a second row (store.ts, app.ts) — but it
--    was never a DB constraint. Making it one means a referrer resolves to exactly one
--    shop, which is what lets the reward pick a single Stripe customer to credit.
--    Partial (owner_id is not null) so the seed/marketing rows with no owner are exempt.
--
-- 2. A stored referral_code, so `referred_by_code` can be resolved BACK to the referrer.
--    Byte-identical to referralCodeOf() (referrals.ts) and to what signup stamps: strip
--    dashes, first 8 hex, uppercase. Generated + indexed so the webhook's reverse lookup
--    is one indexed query, not a scan. A code is only 8 hex, so two DISTINCT owners can
--    collide on it — the reward resolver handles that by granting only on exactly one
--    eligible referrer (see referralReward.ts); the column itself is not unique.

create unique index if not exists merchants_owner_id_key
  on public.merchants (owner_id)
  where owner_id is not null;

alter table public.merchants
  add column if not exists referral_code text
  generated always as (upper(left(replace(owner_id::text, '-', ''), 8))) stored;

create index if not exists merchants_referral_code_idx
  on public.merchants (referral_code);
