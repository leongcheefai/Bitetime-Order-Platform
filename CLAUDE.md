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
pnpm --filter @bitetime/backend test:db     # DB-backed tests: RLS + API (needs a running local Supabase; reads its keys itself)
pnpm --filter @bitetime/backend db:migrate   # apply pending SQL migrations to the LOCAL Supabase DB
pnpm --filter @bitetime/backend db:push      # push migrations to a linked REMOTE Supabase project
```

Migrations live in `apps/backend/supabase/migrations/`. Adding a migration file does **not** apply it — run `db:migrate` (local) so the running app (and PostgREST's schema cache) sees the new columns; otherwise queries fail with `Could not find the 'X' column … in the schema cache`.

Tests use Vitest (added during the multi-merchant build). Pure logic and `store.ts` functions have unit tests (`apps/frontend/src/*.test.ts`); the backend has pure unit tests in `apps/backend/tests/unit/` (run by `test`, no Supabase).

Everything that needs a database is run by `test:db` and needs a running local Supabase (`supabase start` from `apps/backend`): tenant isolation and order attribution in `apps/backend/tests/rls/`, and the API endpoints in `apps/backend/tests/api/`. The API suites drive the real routes **in-process** via Hono's `app.request()` — which is why `src/app.ts` exports the app and `src/index.ts` is a separate entry that only calls `serve()`. Keep `app.ts` free of import-time side effects or the seam closes.

`test:db` uses its own `vitest.db.config.ts`, which reads the stack's URL, keys and `DATABASE_URL` from `supabase status` (and stubs the Stripe keys, which these suites never call) — set them yourself only to point it elsewhere (CI). Missing credentials are a startup **error**, never a skip. **Never mock the database in these suites**: they exist to prove properties of real Postgres — that an order cannot be spoofed onto a stranger's account, that a transaction really rolls back — and a mocked run reports green while asserting nothing, which is worse than no suite at all.

UI is verified by running the app (run-and-verify), not component tests.

## Architecture

Multi-merchant ordering SaaS. React 19 + Vite + React Router (`react-router-dom` v7). Many independent shops, isolated per tenant by Postgres RLS. No global state library — auth/role/lang live in React context.

`main.tsx` mounts `AppRouter`. The legacy single-tenant single-page app (`src/App.tsx` and its components) has been **deleted**; all work goes through the router tree below.

### Routing (`src/AppRouter.tsx`)

| Path | Screen | Guard |
|------|--------|-------|
| `/` | marketing landing (`marketing/Landing.tsx`) | — |
| `/reset-password` | set a new password after a recovery link (`ResetPasswordPage.tsx`) | none — **deliberately top-level**: nested under `/s/:slug` the shell's status gate would swallow it, and a suspended shop must never lock a customer out of their own account. Role-blind; `?shop=<slug>` decides where they land afterwards |
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

All Supabase calls go through `store.ts`. Shared domain types (Merchant, Profile, Product, Order, Voucher, SessionValue, …) live in `src/types.ts`. Postgres tables (`apps/backend/supabase/migrations/`), tenant-scoped by RLS **on the browser's path** — see the caveat under Backend below:

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

### Backend (`apps/backend/src/`)

Hono. `app.ts` defines the routes and **exports the app without serving it**; `index.ts` is the entry that calls `serve()`. That split is what lets `tests/api` drive the real routes in-process via `app.request()` — keep `app.ts` free of I/O at import (it does read `env.ts`, which fails fast on a missing var; that is deliberate and is why the test config stubs the Stripe keys).

Two ways to reach Postgres, and the difference matters:

- **`supabase.ts`** — the REST clients. `admin` (service role, RLS-exempt) and an anon client used only to verify caller JWTs.
- **`db.ts`** — a direct `postgres.js` connection, and the only thing here that can open a **transaction**. `supabase-js` cannot, which is the sole reason the order rules were ever PL/pgSQL: the daily counter needs an atomic upsert and the voucher needs a row lock. Every multi-statement rule goes through `withTransaction()`.

**`db.ts` is RLS-exempt.** It connects as the database owner, so no policy runs on it: on the backend's path, which merchant a row belongs to is a **TypeScript invariant, not a Postgres one**, and any code using it must check tenancy itself. RLS remains in force for the browser's anon/authenticated path and is the backstop — `tests/rls` is the proof it is still shut. Do not read "RLS protects it" as true of anything the backend writes.

Migrating the remaining SQL functions into this layer is #61.

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
