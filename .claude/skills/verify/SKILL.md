---
name: verify
description: Run the BiteTime app against local Supabase and drive a real storefront/dashboard flow in the browser. Use when verifying a change end-to-end (per CLAUDE.md, UI is verified by running the app, not by component tests).
---

# Verify BiteTime by running it

UI is verified by running the app (`CLAUDE.md`). There are no component tests — drive the real thing.

## Bring the stack up

```bash
cd apps/backend && supabase start        # skip if `supabase status` already answers
pnpm --filter @bitetime/frontend dev     # :5173, reads apps/frontend/.env.local
pnpm --filter @bitetime/backend dev      # :8787 — only if the flow hits /api/* (notify, billing, signup)
stripe listen --forward-to http://localhost:8787/api/stripe/webhook   # only for billing flows — see below
```

`apps/frontend/.env.local` already points at the local stack (`http://127.0.0.1:55321`). Pending migrations must be applied first (`pnpm --filter @bitetime/backend db:migrate`) or PostgREST 404s on new columns.

**Verifying anything that pays? Start `stripe listen` FIRST, and confirm it is still alive when the result looks wrong.** Stripe cannot reach `localhost`, and every post-payment effect is webhook-driven — subscription id and status on `merchant_billing`, the `merchants.plan` reconciliation, the pending→active flip. With no forwarder the payment succeeds at Stripe and the app changes nothing, which is indistinguishable from a broken feature: the merchant stays basic, the locks stay on, and the only trace is the `stripe_customer_id` written before the redirect. Its printed secret must match `STRIPE_WEBHOOK_SECRET` in `apps/backend/.env`, or every event is a `<-- [400]`. Missed events replay with `stripe events resend <evt_id>`.

**Two traps that make correct code look broken**, both of which have cost real debugging time:

- **A long-running `pnpm dev` backend can serve pre-edit code.** `--watch` is not enough — clear the jiti cache (`rm -rf node_modules/.cache/jiti`) and restart. Check its age (`/bin/ps -o lstart= -p <pid>`) before blaming a handler.
- **Directly-seeded merchants have no billing row**, so anything reading `merchant_billing` (the Subscription tab, the billing portal) behaves as it does for a shop that never paid. That is correct behaviour on wrong fixtures, not a bug.

Direct DB access for assertions:
`psql "postgresql://postgres:postgres@127.0.0.1:55322/postgres"`

Keys: `cd apps/backend && supabase status -o env` (ANON_KEY, SERVICE_ROLE_KEY).

## Seed a shop you can order from

A storefront only renders at `status = 'active'`. Fastest path is a service-role script (Node, run from a workspace that has `@supabase/supabase-js` — e.g. drop it in `apps/backend/`):

- `merchants` insert needs `order_prefix` (NOT NULL) — two chars, e.g. `'VE'`.
- `products.unit` is the `product_unit` enum: `pcs|box|set|pack|dozen|bottle|jar|tray|slice|kg|g`. Anything else errors.
- Customer accounts: `auth.admin.createUser({ email, password, email_confirm: true })` — without `email_confirm` there is no session and sign-in fails.

Then open `http://localhost:5173/s/<slug>`.

## Driving it

- Chrome automation: fill inputs via `find` + `form_input` rather than click-then-type — the dialog animates in, so coordinates from a screenshot taken before it opened land on the page behind it.
- Sign out without a UI affordance: clear the `sb-*` keys from `localStorage` and reload. Language: `localStorage.setItem('lang','zh')`.
- Postcode `43000` autofills Kajang / Selangor — a quick way to satisfy the delivery address gate.
- The success view only appears after `notifyOrderPlacedRemote` settles; with the backend down the button sits on "Placing order…" for a few seconds first. Not a bug in whatever you're verifying.
- Assert order attribution in SQL, never in the UI: `select order_number, user_id from orders where merchant_id = '<id>' order by created_at desc limit 1;`
