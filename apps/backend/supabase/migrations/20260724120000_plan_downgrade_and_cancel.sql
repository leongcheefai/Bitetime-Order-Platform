-- Scheduled plan changes and cancellation, plus the artifact cutoff that has to follow a
-- real downgrade.
--
-- Until now the app could not tell a subscription that renews from one that is winding down.
-- Stripe fires `customer.subscription.updated` with `status` still 'active' when a merchant
-- cancels at period end, so the Subscription tab went on promising "Renews on 1 Sep" right up
-- to the day `customer.subscription.deleted` suspended the shop. Both columns below exist so
-- that state is visible before the cliff rather than after it.

-- Mirrors `subscription.cancel_at_period_end`. Never inferred from `status`: the status of a
-- subscription cancelling at period end is indistinguishable from a healthy one.
alter table public.merchant_billing
  add column if not exists cancel_at_period_end boolean not null default false;

-- The tier this shop will drop to when the current period ends, written by the downgrade route
-- and cleared by the webhook once the swap has actually happened. NULL means "no change
-- pending", which is not the same as "pending basic" — a merchant who scheduled a downgrade and
-- one who never touched it must not read the same.
--
-- Intent, not entitlement. `merchants.plan` remains the only thing any gate consults; this
-- column exists to be RENDERED. Nothing may grant or revoke access from it, or a shop loses Pro
-- the moment it schedules a downgrade instead of at the end of the period it paid for.
alter table public.merchant_billing
  add column if not exists pending_plan text
  check (pending_plan is null or pending_plan in ('basic', 'pro'));

-- ── Pro artifact cutoff ───────────────────────────────────────────────────────
-- A shop that steps down to Basic kept its Pro artifacts working: vouchers stayed redeemable
-- and promos kept discounting, because the hot paths are plan-blind by design (#110) and
-- nothing revoked the data at the transition. This column is how the cutoff happens WITHOUT
-- putting a plan check inside the priced order transaction — the order path filters on a
-- column it was always going to read, and the tier is consulted once, at the transition.
--
-- Defaults true so every existing voucher keeps working; only a real pro→basic transition
-- flips it.
alter table public.vouchers
  add column if not exists active boolean not null default true;
