# TinyOrder

Multi-merchant food-ordering SaaS. Many independent shops each run their own
storefront, products, orders, vouchers and customers on one platform — fully
isolated per tenant. A platform super-admin approves and suspends merchants.

Built with Vite + React 19 + React Router in TypeScript, backed by Supabase
(Auth + Postgres with Row-Level Security). Deployed on Vercel.

## Monorepo

pnpm + Turborepo. Two workspaces:

| Workspace | Path | What |
|-----------|------|------|
| `@bitetime/frontend` | `apps/frontend` | Vite + React storefront/dashboard |
| `@bitetime/backend` | `apps/backend` | Hono + Stripe billing server; also holds `supabase/`, `tests/`, `scripts/` |

## Quick start

```bash
pnpm install
pnpm dev             # turbo runs frontend (→ http://localhost:5173) + backend (→ :8787)
```

The frontend reads Supabase config from env vars (falls back to a hosted project
if unset). Create `apps/frontend/.env.local`:

```
VITE_SUPABASE_URL=<your-supabase-url>
VITE_SUPABASE_KEY=<your-supabase-publishable-key>
```

## Commands

Run from the repo root (turbo fans out to workspaces):

```bash
pnpm dev           # start all dev servers (frontend :5173, backend :8787)
pnpm build         # production build → apps/frontend/dist/
pnpm lint          # ESLint check (typescript-eslint)
pnpm typecheck     # tsc --noEmit across workspaces
pnpm test          # Vitest unit tests across workspaces
pnpm deploy        # frontend production build (deploy via Vercel)
```

Target a single workspace with `--filter`:

```bash
pnpm --filter @bitetime/frontend dev
pnpm --filter @bitetime/backend dev      # billing server only
pnpm --filter @bitetime/frontend preview # serve built dist/ locally
pnpm --filter @bitetime/backend test     # RLS tenant-isolation tests (needs local Supabase)
```

## How it works

### Roles

Role is derived in `SessionContext` from the logged-in user:

| Role | When | Sees |
|------|------|------|
| `customer` | default | per-shop storefronts at `/s/:slug` |
| `merchant` | user owns a `merchants` row | merchant dashboard at `/merchant` |
| `superadmin` | `profiles.app_role = 'superadmin'` (email fallback during transition) | platform admin at `/admin` |

### Routes (`src/AppRouter.tsx`)

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
(`src/slug.ts`) — pinyin transliteration for Chinese names, `shop-<id>` fallback,
uniqueness suffix (`-2`), and reserved platform segments (`s`, `admin`, `api`,
`merchant`, …) blocked. New shops start `pending` until a super-admin approves.

### Order numbers

Per-merchant prefix + date + random suffix: `<PREFIX>-YYYYMMDD-XXXX`. Prefix is
the first two alphanumerics of the slug, uppercased (`src/orderPrefix.ts`). The
daily counter is per-merchant via the DB `next_order_number` function.

### Data layer

All Supabase access goes through `src/store.ts`; shared domain types live in
`src/types.ts`. Postgres tables (see `supabase/migrations/`):

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

`src/postcodes.ts` maps Malaysian postcodes → city. `lookupPostcode(code)`
returns `{ city, state }` or `null`. Rates come from per-merchant settings:
`WM` (West Malaysia) and `EM` (East Malaysia).

### Localisation

No i18n library. Every string is `t(english, chinese)`; `t` and the `lang`
(`'en'` | `'zh'`) state live in `SessionContext`.

## Local Supabase + testing

The DB-backed suites (RLS tenant isolation, and the API endpoints) need a running local
Supabase. They read its URL, keys and `DATABASE_URL` from `supabase status` themselves, so
there is nothing to pass:

```bash
cd apps/backend
supabase start
pnpm --filter @bitetime/backend test:db
```

Set `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `DATABASE_URL`
yourself only to point the run at a different stack (CI). Missing credentials are a hard
error, never a skip — a suite that asserts nothing but reports green is worse than none.

The pure unit tests need no Supabase: `pnpm --filter @bitetime/backend test`.

Config (`apps/backend/supabase/config.toml`) uses custom ports (API `55321`, db
`55322`) so it can coexist with other local instances. Migrations live in
`apps/backend/supabase/migrations/`.

Promote a user to super-admin with `apps/backend/scripts/promote-superadmin.sh`
(or run `apps/backend/scripts/promote_superadmin.sql` in the SQL editor).

## Project layout

```
apps/frontend/
  src/
    AppRouter.tsx        route table
    SessionContext.tsx   auth + role + lang
    MerchantContext.tsx  resolve shop by slug for storefronts
    RequireRole.tsx      route guard
    types.ts             shared domain types
    marketing/           landing page
    merchant/            signup, login, dashboard (orders, products, settings…)
    store/               customer-facing storefront
    admin/               super-admin merchant management
    components/          shared UI (order form, vouchers, lists…)
    store.ts             all Supabase calls
    slug.ts orderPrefix.ts orderNumber.ts geo.ts postcodes.ts
apps/backend/
  src/                   Hono + Stripe billing server
  supabase/migrations/   schema, RLS, multitenant DML grants
  tests/rls/             tenant-isolation integration tests
  scripts/               superadmin promotion helpers
docs/                    PRD + planning
```

> Note: `src/App.tsx` is the legacy single-tenant single-page app. It is no
> longer mounted (`main.tsx` renders `AppRouter`) and is kept only for reference.

## Deployment

Deployed via Vercel. `pnpm deploy` runs the frontend production build; Vite `base`
is `/`. Set the Vercel project **Root Directory** to `apps/frontend`.
