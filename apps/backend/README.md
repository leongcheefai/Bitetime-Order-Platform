# BiteTime billing server

Standalone Hono backend for Stripe subscriptions. Keeps the Stripe secret key and
Supabase service-role key off the client. The Vite frontend calls `/api/checkout`;
Stripe calls `/api/stripe/webhook`.

## Routes

- `POST /api/checkout` — body `{ plan: 'basic'|'pro', billing: 'monthly'|'yearly' }`,
  `Authorization: Bearer <supabase access token>`. Creates (or reuses) a Stripe
  customer for the caller's merchant and returns `{ url }` to a hosted Checkout
  Session. Basic gets a 7-day trial; both collect a card upfront.
- `POST /api/stripe/webhook` — Stripe-signed events. Writes `merchant_billing` and
  flips `merchants.status` (`active` on checkout, `suspended` on cancellation).
- `GET /health` — liveness check.

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

Copy each Price ID into the matching `STRIPE_PRICE_*` env var. The 7-day trial is
applied per-checkout (`trial_period_days`), not on the price, so no trial config is
needed on the prices themselves.

## Production

Deploy this directory to Railway/Fly/Render (`npm start`). Set all env vars there,
point `FRONTEND_URL` at the Vercel domain, and register the live webhook endpoint in
the Stripe Dashboard (its signing secret becomes `STRIPE_WEBHOOK_SECRET`). Set
`VITE_API_URL` in Vercel to this server's URL.
