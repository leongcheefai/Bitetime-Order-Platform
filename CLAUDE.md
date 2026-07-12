# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Monorepo

pnpm + Turborepo. Three workspaces: `@bitetime/frontend` (`apps/frontend`, Vite+React, **TypeScript**), `@bitetime/backend` (`apps/backend`, Hono+Stripe billing, **TypeScript** — also holds `supabase/`, `tests/`, `scripts/`), and `@bitetime/shared` (`packages/shared`). `docs/` stays at the repo root. Paths below are relative to `apps/frontend/` unless prefixed.

The whole codebase is TypeScript (`.ts`/`.tsx`). Each workspace has its own `tsconfig.json` extending the root `tsconfig.base.json` (both `strict: true`, `noEmit: true` — Vite/esbuild do the emitting). Vite, esbuild, and Vitest compile TS natively. Frontend uses `moduleResolution: bundler` (extensionless relative imports); backend uses `NodeNext` (relative imports keep `.js` specifiers that resolve to the `.ts` source — leave them as `.js`).

`@bitetime/shared` holds **rules that must hold identically on both sides of the wire** — today the customer password floor (`MIN_PASSWORD_LENGTH`, `isPasswordLongEnough`). It ships **TypeScript source, no build step** (`exports: "./src/index.ts"`): both consumers compile TS themselves, so there is no `dist` to keep in sync and no build ordering to get wrong. The one thing this costs: the backend's esbuild bundle can no longer say `--packages=external` (that would leave a bare `@bitetime/shared` import resolving to `.ts` at runtime), so its four real runtime deps are listed with explicit `--external:` flags — **add a new backend runtime dependency and you must add its `--external:` flag too**, or it gets bundled. Anything that is not a shared rule does not belong here; a duplicate with a comment (see `notify.ts`'s currency twin) is the cheaper answer when only one side is authoritative.

## Commands

Run from the repo root; turbo fans out to workspaces. `--filter` targets one.

```bash
pnpm dev           # all dev servers (frontend :5173, backend :8787)
pnpm build         # production build → apps/frontend/dist/
pnpm lint          # ESLint check (typescript-eslint)
pnpm typecheck     # tsc --noEmit across workspaces
pnpm deploy        # frontend production build (deploy via Vercel)
pnpm test          # Vitest unit tests across workspaces
pnpm --filter @bitetime/frontend preview   # serve built dist/ locally
pnpm --filter @bitetime/backend dev         # billing server only
pnpm --filter @bitetime/backend test        # backend unit tests (notify, etc.) — no Supabase needed
pnpm --filter @bitetime/backend test:rls    # RLS tests (needs a running local Supabase; reads its keys itself)
pnpm --filter @bitetime/backend db:migrate   # apply pending SQL migrations to the LOCAL Supabase DB
pnpm --filter @bitetime/backend db:push      # push migrations to a linked REMOTE Supabase project
```

Migrations live in `apps/backend/supabase/migrations/`. Adding a migration file does **not** apply it — run `db:migrate` (local) so the running app (and PostgREST's schema cache) sees the new columns; otherwise queries fail with `Could not find the 'X' column … in the schema cache`.

Tests use Vitest (added during the multi-merchant build). Pure logic and `store.ts` functions have unit tests (`apps/frontend/src/*.test.ts`); the backend has pure unit tests in `apps/backend/tests/unit/` (run by `test`, no Supabase); tenant isolation and order attribution are covered by integration tests in `apps/backend/tests/rls/` (run by `test:rls`) that need a running local Supabase (`supabase start` from `apps/backend`). `test:rls` uses its own `vitest.rls.config.ts`, which reads the stack's URL and keys from `supabase status` — set `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` yourself only to point it elsewhere (CI). Missing credentials are a startup **error**, never a skip: these suites are the only proof orders can't be spoofed, so a green run that asserted nothing is worse than none. UI is verified by running the app (run-and-verify), not component tests.

## Architecture

Multi-merchant ordering SaaS. React 19 + Vite + React Router (`react-router-dom` v7). Many independent shops, isolated per tenant by Postgres RLS. No global state library — auth/role/lang live in React context.

`main.tsx` mounts `AppRouter`. The legacy single-tenant single-page app (`src/App.tsx` and its components) has been **deleted**; all work goes through the router tree below.

### Routing (`src/AppRouter.tsx`)

| Path | Screen | Guard |
|------|--------|-------|
| `/` | marketing landing (`marketing/Landing.tsx`) | — |
| `/s/:slug/*` | merchant storefront (`store/Storefront.tsx`) | `MerchantProvider` resolves shop by slug; gated on `status === 'active'` |
| `/merchant/signup`, `/merchant/login` | shop signup / login | — |
| `/merchant` | merchant dashboard (`merchant/MerchantHome.tsx`) | role `merchant` |
| `/admin`, `/admin/merchants` | manage merchants (`admin/AdminMerchants.tsx`) | role `superadmin` |

`RequireRole` is the route guard; `superadmin` passes any guard.

### Auth & roles

- Supabase Auth handles login/registration (`src/supabase.ts`, `src/store.ts`)
- `SessionContext` derives `role`: `superadmin` if `profiles.app_role === 'superadmin'` (transitional email fallback to `bitetime@praxor.dev`), else `merchant` if the user owns a `merchants` row, else `customer`
- `MerchantContext` resolves the active shop for `/s/:slug` storefronts

### Merchant onboarding & slugs (`src/slug.ts`)

Sign up with a shop name → auto slug: pinyin transliteration for Chinese names, `shop-<id>` fallback, uniqueness suffix (`-2`), reserved platform segments blocked (`RESERVED_SLUGS`: `s`, `admin`, `api`, `merchant`, …). New shops start `pending` until a superadmin approves.

### Data layer (`src/store.ts`)

All Supabase calls go through `store.ts`. Shared domain types (Merchant, Profile, Product, Order, Voucher, SessionValue, …) live in `src/types.ts`. Postgres tables (`apps/backend/supabase/migrations/`), all tenant-scoped by RLS:

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

`Storefront` collects items, delivery mode, voucher → `priceOrder()` for the total → `placeOrder()` (inserts via the `next_order_number` RPC) → `redeemVoucher()` records voucher use → `notifyOrderPlacedRemote()` triggers the backend Telegram send → confirms order number. The Telegram bot token never reaches the browser: the backend (`POST /api/notify/order`) reads it from `merchant_secrets` and sends server-side.

Order numbers: `<PREFIX>-YYYYMMDD-XXXX`. Prefix = first two alphanumerics of the slug, uppercased (`src/orderPrefix.ts`). Daily counter is per-merchant via the DB `next_order_number` function.

### Shipping / pricing

All order totals come from one pure module, `src/pricing.ts` — `priceOrder()` (shipping region, promo, voucher, referral, rounding) and `voucherError()`. Shipping rates are per-merchant: `WM` (West Malaysia) and `EM` (East Malaysia), with `EM_STATES` selecting the region; a storefront that collects no state passes `resolvedShipping` (flat fee). See `CONTEXT.md → Order pricing`.

### Localisation

No i18n library. Every string is passed as `t(englishString, chineseString)` where `t = (en, zh) => lang === 'zh' ? zh : en`. `t` and the `lang` (`'en'` | `'zh'`) state live in `SessionContext`.

### Deployment

Deployed via Vercel; set the project **Root Directory** to `apps/frontend`. `pnpm deploy` runs the frontend `vite build`. Vite `base` is `/`.

## Agent skills

### Issue tracker

Issues and PRDs live as GitHub issues (`esther0716/Bitetime-Order-Platform`), via the `gh` CLI. External PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical label vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
