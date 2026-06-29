# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Monorepo

pnpm + Turborepo. Two workspaces: `@bitetime/frontend` (`apps/frontend`, Vite+React) and `@bitetime/backend` (`apps/backend`, Hono+Stripe billing — also holds `supabase/`, `tests/`, `scripts/`). `docs/` stays at the repo root. Paths below are relative to `apps/frontend/` unless prefixed.

## Commands

Run from the repo root; turbo fans out to workspaces. `--filter` targets one.

```bash
pnpm dev           # all dev servers (frontend :5173, backend :8787)
pnpm build         # production build → apps/frontend/dist/
pnpm lint          # ESLint check
pnpm deploy        # frontend production build (deploy via Vercel)
pnpm test          # Vitest unit tests across workspaces
pnpm --filter @bitetime/frontend preview   # serve built dist/ locally
pnpm --filter @bitetime/backend dev         # billing server only
pnpm --filter @bitetime/backend test        # RLS tenant-isolation tests (needs local Supabase env vars)
```

Tests use Vitest (added during the multi-merchant build). Pure logic and `store.js` functions have unit tests (`apps/frontend/src/*.test.js`); tenant isolation is covered by integration tests in `apps/backend/tests/rls/` that need a running local Supabase (`supabase start`) and its keys as env vars. UI is verified by running the app (run-and-verify), not component tests.

## Architecture

Multi-merchant ordering SaaS. React 19 + Vite + React Router (`react-router-dom` v7). Many independent shops, isolated per tenant by Postgres RLS. No global state library — auth/role/lang live in React context.

`main.jsx` mounts `AppRouter`. **`src/App.jsx` is the legacy single-tenant single-page app — no longer mounted, kept only for reference.** Do not extend it; new work goes through the router tree below.

### Routing (`src/AppRouter.jsx`)

| Path | Screen | Guard |
|------|--------|-------|
| `/` | marketing landing (`marketing/Landing.jsx`) | — |
| `/s/:slug/*` | merchant storefront (`store/Storefront.jsx`) | `MerchantProvider` resolves shop by slug; gated on `status === 'active'` |
| `/merchant/signup`, `/merchant/login` | shop signup / login | — |
| `/merchant` | merchant dashboard (`merchant/MerchantHome.jsx`) | role `merchant` |
| `/admin`, `/admin/merchants` | manage merchants (`admin/AdminMerchants.jsx`) | role `superadmin` |

`RequireRole` is the route guard; `superadmin` passes any guard.

### Auth & roles

- Supabase Auth handles login/registration (`src/supabase.js`, `src/store.js`)
- `SessionContext` derives `role`: `superadmin` if `profiles.app_role === 'superadmin'` (transitional email fallback to `bitetimeandco@gmail.com`), else `merchant` if the user owns a `merchants` row, else `customer`
- `MerchantContext` resolves the active shop for `/s/:slug` storefronts

### Merchant onboarding & slugs (`src/slug.js`)

Sign up with a shop name → auto slug: pinyin transliteration for Chinese names, `shop-<id>` fallback, uniqueness suffix (`-2`), reserved platform segments blocked (`RESERVED_SLUGS`: `s`, `admin`, `api`, `merchant`, …). New shops start `pending` until a superadmin approves.

### Data layer (`src/store.js`)

All Supabase calls go through `store.js`. Postgres tables (`apps/backend/supabase/migrations/`), all tenant-scoped by RLS:

| Table | Purpose |
|-------|---------|
| `merchants` | shop record — slug, status (`pending`/`active`/suspended), prefix |
| `merchant_secrets` | per-merchant secrets (Telegram token etc.), restricted grants |
| `profiles` | user profile + `app_role` + saved delivery address |
| `products` | per-merchant menu items (EN/ZH name + description) |
| `orders` | per-merchant orders |
| `order_counters` | per-merchant daily order counter |
| `vouchers` | per-merchant promotions |
| `settings` | per-merchant config (shipping, payment, notifications) |

### Order flow

`Storefront` collects items, delivery mode, date, voucher → `saveOrder()` → sends Telegram notification (per-merchant `tgToken`/`tgChatId`) and optionally EmailJS → confirms order number.

Order numbers: `<PREFIX>-YYYYMMDD-XXXX`. Prefix = first two alphanumerics of the slug, uppercased (`src/orderPrefix.js`). Daily counter is per-merchant via the DB `next_order_number` function.

### Shipping / postcodes

`src/postcodes.js` maps Malaysian postcodes → city. `lookupPostcode(code)` returns `{ city, state }` or `null`. Rates from per-merchant settings: `WM` (West Malaysia) and `EM` (East Malaysia).

### Localisation

No i18n library. Every string is passed as `t(englishString, chineseString)` where `t = (en, zh) => lang === 'zh' ? zh : en`. `t` and the `lang` (`'en'` | `'zh'`) state live in `SessionContext`.

### Deployment

Deployed via Vercel; set the project **Root Directory** to `apps/frontend`. `pnpm deploy` runs the frontend `vite build`. Vite `base` is `/`.
