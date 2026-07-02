-- Track whether a trialing merchant has already attached a payment method, so the
-- countdown banner stops nagging "Add a payment method" once they have. Written
-- only by the Stripe webhook (service role), derived from the subscription's
-- default_payment_method (or the customer default). See issue #30.

alter table public.merchant_billing
  add column if not exists has_payment_method boolean not null default false;
