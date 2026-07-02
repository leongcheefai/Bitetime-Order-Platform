# BiteTime billing server

Standalone Hono backend for Stripe subscriptions. Keeps the Stripe secret key and
Supabase service-role key off the client. The Vite frontend calls `/api/checkout`;
Stripe calls `/api/stripe/webhook`.

## Routes

- `POST /api/checkout` — body `{ plan: 'basic'|'pro', billing: 'monthly'|'yearly' }`,
  `Authorization: Bearer <supabase access token>`. Creates (or reuses) a Stripe
  customer for the caller's merchant and returns `{ url }` to a hosted Checkout
  Session. Paid path only (pro signup + reactivation) — never grants a trial.
- `POST /api/stripe/webhook` — Stripe-signed events. Writes `merchant_billing` and
  flips `merchants.status` (`active` on checkout, `suspended` on cancellation).
- `GET /health` — liveness check.
- `POST /api/admin/approve-merchant` — body `{ merchantId }`, superadmin JWT.
  Creates the Stripe customer + 7-day cardless trialing subscription
  (`missing_payment_method: 'cancel'`) and flips the merchant `active`. The only
  place a trial is ever granted; refuses pro-plan and non-pending merchants.
- `POST /api/billing/portal` — merchant JWT. Returns `{ url }` to a Stripe
  billing-portal session (add/update card). Requires the portal to be enabled
  once in the Stripe Dashboard.

## Local setup

1. `npm install`
2. `cp .env.example .env` and fill in (Supabase keys from `supabase status`).
3. Create Stripe products/prices (below) and paste the 4 price IDs into `.env`.
4. `npm run dev` (port 8787).
5. Forward webhooks: `stripe listen --forward-to localhost:8787/api/stripe/webhook`
   then paste the printed `whsec_…` into `STRIPE_WEBHOOK_SECRET`.

## Stripe products/prices (one-time)

In the Stripe Dashboard (test mode) create:

- **Product: Basic** → recurring prices: RM 9.99/month, RM 99.90/year
- **Product: Pro** → recurring prices: RM 39.99/month, RM 399.90/year

Copy each Price ID into the matching `STRIPE_PRICE_*` env var.

One-time Stripe Dashboard setup beyond prices:

- **Billing portal**: Settings → Billing → Customer portal → enable (allow
  payment-method updates). `/api/billing/portal` fails until this is done.
- **Webhook events** (production endpoint): `checkout.session.completed`,
  `customer.subscription.updated`, `customer.subscription.deleted`,
  `customer.subscription.trial_will_end`, `invoice.payment_failed`.
  (`stripe listen` forwards everything locally.)
- **Dunning**: Settings → Billing → Revenue recovery — after smart retries are
  exhausted, set "cancel the subscription" so the `subscription.deleted`
  webhook suspends the shop.
- Trials are applied per-subscription by the approve endpoint
  (`trial_period_days: 7`, cancel-if-no-card), not on the prices.

## Production

Deploy this directory to Railway/Fly/Render (`npm start`). Set all env vars there,
point `FRONTEND_URL` at the Vercel domain, and register the live webhook endpoint in
the Stripe Dashboard (its signing secret becomes `STRIPE_WEBHOOK_SECRET`). Set
`VITE_API_URL` in Vercel to this server's URL.
