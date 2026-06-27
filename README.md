# BiteTime

Multi-merchant food-ordering SaaS. Many independent shops each run their own
storefront, products, orders, vouchers and customers on one platform — fully
isolated per tenant. A platform super-admin approves and suspends merchants.

Built with Vite + React 19 + React Router, backed by Supabase (Auth + Postgres
with Row-Level Security). Deployed on Vercel.

## Quick start

```bash
npm install
npm run dev          # Vite dev server → http://localhost:5173
```

The app reads Supabase config from env vars (falls back to a hosted project if
unset). Create `.env.local`:

```
VITE_SUPABASE_URL=<your-supabase-url>
VITE_SUPABASE_KEY=<your-supabase-publishable-key>
```

## Commands

```bash
npm run dev        # start Vite dev server (localhost:5173)
npm run build      # production build → dist/
npm run preview    # serve dist/ locally
npm run lint       # ESLint check
npm run deploy     # production build (deploy via Vercel)
npm test           # Vitest unit tests (run once)
npm run test:rls   # RLS tenant-isolation integration tests (needs local Supabase)
npm run test:watch # Vitest in watch mode
```

## How it works

### Roles

Role is derived in `SessionContext` from the logged-in user:

| Role | When | Sees |
|------|------|------|
| `customer` | default | per-shop storefronts at `/s/:slug` |
| `merchant` | user owns a `merchants` row | merchant dashboard at `/merchant` |
| `superadmin` | `profiles.app_role = 'superadmin'` (email fallback during transition) | platform admin at `/admin` |

### Routes (`src/AppRouter.jsx`)

| Path | Screen | Guard |
|------|--------|-------|
| `/` | marketing landing | — |
| `/s/:slug/*` | merchant storefront (order flow) | resolves shop by slug |
| `/merchant/signup` | shop signup (name → auto slug) | — |
| `/merchant/login` | merchant login | — |
| `/merchant` | merchant dashboard | role `merchant` |
| `/admin`, `/admin/merchants` | approve / suspend merchants | role `superadmin` |

### Merchant onboarding

Sign up with just a shop name. The storefront slug is auto-generated
(`src/slug.js`) — pinyin transliteration for Chinese names, `shop-<id>` fallback,
uniqueness suffix (`-2`), and reserved platform segments (`s`, `admin`, `api`,
`merchant`, …) blocked. New shops start `pending` until a super-admin approves.

### Order numbers

Per-merchant prefix + date + random suffix: `<PREFIX>-YYYYMMDD-XXXX`. Prefix is
the first two alphanumerics of the slug, uppercased (`src/orderPrefix.js`). The
daily counter is per-merchant via the DB `next_order_number` function.

### Data layer

All Supabase access goes through `src/store.js`. Postgres tables (see
`supabase/migrations/`):

| Table | Purpose |
|-------|---------|
| `merchants` | shop record (slug, status, prefix) |
| `merchant_secrets` | per-merchant secrets (Telegram token, etc.), restricted grants |
| `profiles` | user profile + `app_role` + saved delivery address |
| `products` | per-merchant menu items (EN/ZH name + description) |
| `orders` | per-merchant orders |
| `order_counters` | per-merchant daily order counter |
| `vouchers` | per-merchant promotions |
| `settings` | per-merchant config (shipping, payment, notifications) |

Tenant isolation is enforced by Postgres RLS and covered by integration tests in
`tests/rls/`.

### Storefront order flow

`Storefront` collects items, delivery mode, date and voucher → `saveOrder()` →
sends a Telegram notification (per-merchant `tgToken`/`tgChatId`) and optionally
an EmailJS email → confirms the order number.

### Shipping / postcodes

`src/postcodes.js` maps Malaysian postcodes → city. `lookupPostcode(code)`
returns `{ city, state }` or `null`. Rates come from per-merchant settings:
`WM` (West Malaysia) and `EM` (East Malaysia).

### Localisation

No i18n library. Every string is `t(english, chinese)`; `t` and the `lang`
(`'en'` | `'zh'`) state live in `SessionContext`.

## Local Supabase + testing

RLS tests need a running local Supabase and its keys:

```bash
supabase start
SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... npm run test:rls
```

Config (`supabase/config.toml`) uses custom ports (API `55321`, db `55322`) so it
can coexist with other local instances. Migrations live in `supabase/migrations/`.

Promote a user to super-admin with `scripts/promote-superadmin.sh` (or run
`scripts/promote_superadmin.sql` in the SQL editor).

## Project layout

```
src/
  AppRouter.jsx        route table
  SessionContext.jsx   auth + role + lang
  MerchantContext.jsx  resolve shop by slug for storefronts
  RequireRole.jsx      route guard
  marketing/           landing page
  merchant/            signup, login, dashboard (orders, products, settings…)
  store/               customer-facing storefront
  admin/               super-admin merchant management
  components/          shared UI (order form, vouchers, lists…)
  store.js             all Supabase calls
  slug.js orderPrefix.js orderNumber.js geo.js postcodes.js
supabase/migrations/   schema, RLS, multitenant DML grants
tests/rls/             tenant-isolation integration tests
docs/                  PRD + planning
```

> Note: `src/App.jsx` is the legacy single-tenant single-page app. It is no
> longer mounted (`main.jsx` renders `AppRouter`) and is kept only for reference.

## Deployment

Deployed via Vercel. `npm run deploy` runs the production build; Vite `base` is `/`.
