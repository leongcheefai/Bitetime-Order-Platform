-- Merchant-selectable base currency (issue #18).
-- Currency is display + pricing-unit only — no FX, no change to Stripe charge
-- currency. Existing merchants default to Ringgit, so the rollout is silent.

-- Per-merchant base currency. Dedicated column (queried, surfaced in UI, frozen
-- per order) rather than inside the `config` jsonb bag. Existing anon RLS on
-- active shops already covers reads of the merchants row.
alter table public.merchants
  add column if not exists currency text not null default 'MYR';

-- Currency the order was placed in, stamped at placement and frozen forever so
-- historical orders never silently re-denominate. Nullable for legacy rows;
-- new orders always set it.
alter table public.orders
  add column if not exists currency text;
