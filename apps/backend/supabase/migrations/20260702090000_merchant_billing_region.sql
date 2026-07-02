-- Billing region chosen at signup (drives which Stripe Price the trial
-- subscription uses). Recorded on the merchant because basic-plan signup no
-- longer goes through Checkout, so approval needs it server-side.
alter table public.merchants
  add column if not exists billing_region text not null default 'US';
