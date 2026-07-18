# Move data access from the browser to the backend API

**Date:** 2026-07-18
**Status:** Approved design, ready for planning
**Scope:** All browser→Postgres data access moves behind the Hono backend API. Two phases; this doc covers both, but Phase A (reads) ships and is verified before Phase B (writes) begins.

## Motivation

Today the browser talks to Postgres directly through `supabase-js` (`supabase.from(...)`) for both reads and writes, with the anon/authenticated **grants + RLS** as the only tenant boundary. The goal is better security and maintainability: route all table access through the backend, where tenancy is enforced in TypeScript against the service-role client, and ultimately **revoke the browser's table grants entirely** so a missed or malicious direct query cannot reach data at all. RLS stays in place as the backstop (per `CLAUDE.md`), never the primary gate.

## Non-goals / out of scope

- **`supabase.auth.*`** (login, signup, `getSession`, `resetPasswordForEmail`, `updateUser`, `onAuthStateChange`) — this is Supabase Auth (GoTrue), not table access. Stays browser-side. REVOKE on tables does not touch it.
- **`supabase.storage`** (`product-images` bucket: `productImageUrl`, `uploadProductImages`, `deleteProductImages`) — storage objects, guarded by storage policies, not table grants. Stays browser-side.
- The order-intake path (`POST /api/orders`), Telegram notify, guest tracking, referrals, checkout, billing portal, admin approve/status/comp — **already** go through the backend. Untouched except where the new middleware refactors their inline authz.

## Design decisions (locked)

| Decision | Choice |
|----------|--------|
| Scope | All data access (reads **and** writes) |
| API shape | Resource REST (`GET /api/merchants/:slug`, …) |
| Auth structure | Shared Hono middleware (`requireUser` / `requireMerchantOwns` / `requireSuperadmin`) |
| Browser grants end-state | REVOKE ALL on migrated tables from `anon`, `authenticated` |
| REVOKE timing | A single `REVOKE ALL` migration in **Phase B**, after writes migrate. Phase A revokes SELECT only on `merchant_billing` (the one table with no browser write). RLS stays as backstop. |
| Sequencing | Phase A (reads) → ship + verify → Phase B (writes) |

### Why REVOKE waits for Phase B

PostgREST needs the **SELECT grant to return rows from a write** (`.insert().select()`, `.update().select()`, `.upsert().select()`). In Phase A the browser still writes to `orders`, `products`, `vouchers`, `profiles`, `merchants`, and those writes use RETURNING. Revoking their SELECT during Phase A would break the writes. `merchant_billing` is the sole exception — the browser only ever reads it (all writes already go through the backend) — so its SELECT is revoked in Phase A. Everything else is revoked together at the end of Phase B.

## Architecture

### Frontend seam is preserved

`apps/frontend/src/store.ts` remains the single data-access module. Each migrated function keeps its **exact signature and return contract**; only its body changes from `supabase.from(...)` to `fetch(\`${API_URL}/...\`)`. Callers (`SessionContext`, `MerchantContext`, `Storefront`, `MerchantHome`, `AdminMerchants`, product manager) are untouched. This is what keeps the blast radius reviewable.

### Backend middleware (new: `apps/backend/src/mw.ts`)

Hono middleware, set once, reused across old and new routes:

- **`requireUser`** — extract Bearer token, `getUserFromToken`; 401 if absent; else `c.set('user', user)`.
- **`requireSuperadmin`** — `requireUser` + load `profiles.app_role` (with the transitional `bitetime@praxor.dev` email fallback, mirroring current inline checks); 403 unless superadmin.
- **`requireMerchantOwns`** — `requireUser` + load the caller's owned merchant (`merchants.owner_id = user.id`); for routes carrying `:id`, assert `:id === ownedMerchant.id`; superadmin bypasses the ownership check. 403 on mismatch; else `c.set('merchant', merchant)`.

The three existing admin routes (`approve-merchant`, `set-merchant-status`, `comp-merchant`) are refactored onto `requireSuperadmin`, deleting their duplicated inline token→profile→role boilerplate. No behavior change.

### Data access on the backend

New read handlers use the existing service-role `admin` client (`apps/backend/src/supabase.ts`). Because `admin` is RLS-exempt, **tenancy is a TypeScript invariant enforced by the middleware**, exactly as the existing backend routes already operate. RLS remains in force on the browser's anon/authenticated path and is proven shut by `tests/rls`.

## Phase A — reads

### Endpoints

| Tier | Method + Route | Middleware | Replaces (`store.ts`) | Notes |
|------|----------------|------------|-----------------------|-------|
| Public | `GET /api/merchants/:slug` | none | `fetchMerchantBySlug` | Return a **public-safe shape** — omit `owner_id`, `referred_by_code`, and other internal columns; include what the storefront renders (name, slug, status, currency, shipping/payment/notification config, prefix). Reserved-slug guard stays. |
| Public | `GET /api/merchants/:id/products` | none | `fetchProducts` / `lookupProducts` | Ordered by `sort`, then `created_at`. See null-contract below. |
| Public | `GET /api/merchants/:id/vouchers/:code` | none | `lookupMerchantVoucher` / `fetchMerchantVoucher` | Single voucher by code. See null-contract below. |
| User | `GET /api/me/profile` | `requireUser` | `fetchProfileByUserId` | Global profile (`merchant_id IS NULL`) for the caller. |
| User | `GET /api/me/merchant` | `requireUser` | `fetchMyMerchant` | Caller's owned shop (or 200 `null`). |
| User | `GET /api/merchants/:id/my-orders` | `requireUser` | `fetchMyOrdersAtShop` | Filtered to `user_id = caller` — the filter is the point (merchant-owned select policy would otherwise expose all). |
| Owner | `GET /api/merchants/:id/orders` | `requireMerchantOwns` | `fetchMerchantOrders` | Full shop order list, newest first. |
| Owner | `GET /api/merchants/:id/orders/count` | `requireMerchantOwns` | `merchantHasOrders` | Returns `{ count }`; caller derives the boolean. |
| Owner | `GET /api/merchants/:id/vouchers` | `requireMerchantOwns` | `fetchMerchantVouchers` | Merchant voucher management list. |
| Owner | `GET /api/merchants/:id/billing` | `requireMerchantOwns` | `fetchMyBilling` | |
| Owner | `GET /api/merchants/:id/secret` | `requireMerchantOwns` | `fetchMerchantSecret` | Telegram token/chat — sensitive; owner-only. |
| Super | `GET /api/merchants` | `requireSuperadmin` | `fetchAllMerchants` | All shops, newest first. |
| Super | `GET /api/billing` | `requireSuperadmin` | `fetchAllBilling` | All billing rows. |

`fetchMerchantCustomers` is a pure client-side aggregation over `fetchMerchantOrders` — no endpoint, it just consumes the new orders endpoint.

### The null-vs-"could-not-ask" contract (highest-risk port)

`lookupProducts` and `lookupMerchantVoucher` deliberately distinguish two failure shapes, and their callers depend on it (Storefront prunes the cart against the menu; voucher apply drops the code). `supabase-js` resolves `{ data: null, error }` on failure — never rejects — so the current code reads `error` to tell "the shop genuinely has none" from "I could not reach the server."

The fetch ports must preserve this exactly:

- **HTTP 200** → the real answer (array possibly empty; voucher possibly `null`).
- **network failure / non-2xx / 5xx** → the *could-not-ask* signal: `lookupProducts` returns `null`; `lookupMerchantVoucher` returns `{ ok: false }`.

`fetch` **rejects** on network/CORS failure (unlike supabase-js), so every wrapper wraps in try/catch and maps a rejection to the could-not-ask signal, never letting it throw where the old code returned a sentinel. Functions that intentionally `throw` on error today (`fetchMyOrdersAtShop`, `fetchAllMerchants`, `fetchAllBilling`) keep throwing on non-2xx.

### Phase A grant change

One migration: `REVOKE SELECT ON merchant_billing FROM anon, authenticated;` (its only browser access was the two reads now migrated). All other tables keep their grants until Phase B. RLS unchanged.

## Phase B — writes (outline, planned separately)

Migrates the remaining direct writes to backend endpoints:

- `profiles`: `ensureGlobalProfile`, `saveCustomerDetails`, `globalProfileId` (read helper used only by these writes)
- `vouchers`: `createMerchantVoucher`, `deleteMerchantVoucher`
- `orders`: `setOrderStatus`, `setOrderNote`, `setOrderTracking`
- `products`: `upsertProduct`, `deleteProduct`
- `merchants`: `createMerchant`, `updateMerchantConfig`, `updateMerchantSlug`, plus `listTakenSlugs` — **slug resolution moves server-side** into the create/rename endpoints (it is the last browser read of `merchants`)
- `merchant_secrets`: `upsertMerchantSecret`

Then the terminal migration:
```sql
REVOKE ALL ON orders, products, vouchers, merchants, profiles,
  merchant_secrets, merchant_billing FROM anon, authenticated;
```
RLS policies stay in place as defense-in-depth. Storage and `supabase.auth` grants are untouched.

## Testing

- **`tests/api`** (in-process via `app.request()`, needs local Supabase): one suite per new endpoint asserting the happy path plus the authz matrix — a non-owner merchant gets 403 on another shop's `orders`/`vouchers`/`billing`/`secret`; a non-super gets 403 on `GET /api/merchants` and `/api/billing`; an anonymous caller gets 401 on `requireUser` routes; public routes return without a token. Explicitly assert **tenant isolation**: merchant A cannot read merchant B's rows through any route.
- **Null-contract tests**: `products` and `vouchers/:code` endpoints — a 200 with an empty result vs. a simulated failure map to the two distinct client signals. Port the intent of the existing `store.ts` unit tests to the new wrappers.
- **`tests/rls`** unchanged — still proves RLS is shut on the browser path.
- After the Phase A `merchant_billing` revoke (and the Phase B `REVOKE ALL`), add a DB-backed test asserting an `anon`/`authenticated` SELECT on the revoked table(s) is denied — belt on top of the code path.
- **Run-and-verify** (per `CLAUDE.md`, UI is verified by running the app): storefront (browse shop by slug, menu, apply voucher, place order, view own history) and dashboard (orders list, vouchers, billing, secret/config) both exercised end-to-end after Phase A.

## Rollout

1. Phase A: middleware + read endpoints + `merchant_billing` SELECT revoke + tests. Ship. Verify storefront + dashboard against the deployed API.
2. Phase B: write endpoints + slug resolution server-side + `REVOKE ALL` migration + tests. Ship. Verify.

Each phase is independently deployable: after Phase A the browser reads only through the API but still writes directly; after Phase B the browser holds **zero** table grants.
