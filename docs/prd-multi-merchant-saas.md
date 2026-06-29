# PRD: Multi-Merchant SaaS — Merchant Onboarding & Self-Serve Management

## Problem Statement

BiteTime is a single-tenant ordering app. Exactly one business (gated by a hardcoded `OWNER_EMAIL`) can manage products, orders, vouchers and customers. Other businesses cannot use the platform at all — there is no way for a new merchant to sign up, get their own storefront, list their own products, or manage their own customers. Today only customer login/signup exists. The owner wants to turn BiteTime from one shop into a platform where many independent businesses each run their own shop.

## Solution

Convert the app into a multi-merchant SaaS:

- A new business signs up with just a shop name, gets an auto-generated storefront URL, and (after platform approval) manages its own products, orders, vouchers and customers from a merchant dashboard.
- Each merchant gets a path-slug storefront at `/s/:slug` where their customers browse and order.
- Customers, orders, products and vouchers are isolated per merchant; no merchant can see another merchant's data.
- The original owner becomes a **platform super-admin** who approves/suspends merchants and can see across all tenants.
- BiteTime itself re-onboards as the first merchant on the new schema (fresh start — existing global data is not migrated).

## User Stories

### Merchant — signup & onboarding
1. As a prospective merchant, I want to sign up by entering only my shop name, so that I can start without filling a long form.
2. As a prospective merchant, I want a storefront URL slug auto-generated from my shop name, so that I don't have to invent one.
3. As a merchant with a Chinese shop name, I want my slug generated via pinyin transliteration, so that my URL is still readable latin text.
4. As a merchant whose name produces no usable slug, I want a `shop-<id>` fallback slug, so that I always get a working URL.
5. As a merchant, I want my slug to be made unique automatically (e.g. suffixed `-2`), so that two shops with the same name don't collide.
6. As a merchant, I want to edit my slug exactly once during onboarding before going live, so that I can fix an ugly auto-slug but can't break shared links later.
7. As a merchant, I want to be told which slugs are reserved (e.g. `admin`, `s`, `api`, `merchant`), so that I don't pick one that conflicts with platform routes.
8. As a merchant, I want my shop to start in a `pending` state after signup, so that I understand it isn't live until approved.
9. As a merchant, I want to see my approval status, so that I know whether I can go live.

### Merchant — store configuration
10. As a merchant, I want to add, edit and remove my own products (incl. English/Chinese name and description), so that my storefront reflects my menu.
11. As a merchant, I want to set my own delivery zones and shipping rates, so that delivery matches my coverage.
12. As a merchant, I want to configure my own payment details (QR image / bank details), so that my customers pay me directly.
13. As a merchant, I want to configure my own Telegram bot token and chat ID, so that order notifications go to me, not the platform.
14. As a merchant, I want to create and manage my own vouchers (incl. multi-use with per-customer limits), so that I run my own promotions.

### Merchant — operations
15. As a merchant, I want to see only my own orders, so that my operational view is not polluted by other shops.
16. As a merchant, I want order numbers prefixed with my own merchant prefix (e.g. `<PREFIX>-YYYYMMDD-XXXX`), so that my orders are identifiable as mine.
17. As a merchant, I want a per-merchant daily order counter, so that my numbering is independent of other merchants.
18. As a merchant, I want to update order status and add tracking numbers for my orders, so that I can fulfil them.
19. As a merchant, I want to add internal notes to my orders, so that I can track special handling.
20. As a merchant, I want to see only my own customers and their order history, so that I can manage my customer base.

### Customer (per-merchant)
21. As a customer, I want to reach a specific shop at `/s/:slug`, so that I browse that shop's menu.
22. As a customer, I want to sign up / log in within a shop's context, so that my account is associated with that merchant.
23. As a customer with one login, I want a separate profile per merchant I order from, so that my details/history are scoped to each shop.
24. As a customer, I want to place an order against a specific merchant, so that the right shop fulfils it.
25. As a customer, I want order notifications/payment instructions to come from the merchant I ordered from, so that I pay and contact the right party.
26. As a customer, I want my voucher/order-history drawer to show only the current merchant's data, so that I'm not confused by unrelated shops.
27. As a customer, I want the storefront available in English or Chinese, so that I use my preferred language (existing `t()` behaviour preserved).

### Platform super-admin
28. As a super-admin, I want to see a queue of pending merchant signups, so that I can review them.
29. As a super-admin, I want to approve a pending merchant, so that their store goes live.
30. As a super-admin, I want to reject/suspend a merchant, so that I can stop abuse.
31. As a super-admin, I want to view all merchants and their statuses, so that I can manage the platform.
32. As a super-admin, I want my role to be determined by my account role, not a hardcoded email, so that admin access is data-driven.

### Routing & landing
33. As a visitor at the root `/`, I want a marketing page explaining the platform with a "Start your shop" CTA, so that I'm guided to merchant signup.
34. As any user, I want navigation handled by real routes (`/`, `/s/:slug`, `/s/:slug/account`, `/merchant/*`, `/admin/*`), so that URLs are shareable and bookmarkable.

### Security / isolation
35. As a merchant, I want it to be impossible for another merchant to read my customers/orders even with the public anon key, so that my data is private.
36. As a super-admin, I want to read across all tenants, so that I can administer the platform.

## Implementation Decisions

### Tenancy model
- **Multi-tenant via `merchant_id` on every tenant-owned table.** Path-slug storefronts at `/s/:slug`.
- **One Supabase Auth user per person, profile-per-merchant.** Supabase Auth is global-by-email, so "per-merchant customers" is realised at the data layer: `profiles` gets a row per `(user_id, merchant_id)` pair. `profiles` primary key moves off `id` to a composite/surrogate keyed by `(user_id, merchant_id)`. (Resolves the auth-vs-tenancy contradiction; compounds the existing PK quirk noted in prior DB/code-drift work.)
- **Role-based access.** Add a `role` concept (`customer` | `merchant` | `superadmin`). This replaces the hardcoded `OWNER_EMAIL` gate in `App.tsx`.

### Schema (fresh start — no migration of existing global data)
- New `merchants` table: `id`, `name`, `slug` (unique), `status` (`pending` | `active` | `suspended`), `order_prefix`, payment config (QR / bank / `tg_token` / `tg_chat_id`), delivery zones/rates.
- `products`, `vouchers`, `orders` become **proper tables** (not JSON blobs in `settings`), each with a `merchant_id` FK.
- `profiles` gains `merchant_id`; keyed per `(user_id, merchant_id)`.
- Per-merchant order counter (a row per merchant, replacing the single global `order_counter`).
- The previous global `settings` key-value blob model (`main`, `vouchers`, `order_statuses`, `order_awb`, `order_counter`, etc.) is retired in favour of real tables. Order status / AWB / notes become columns/rows on `orders` scoped by `merchant_id`.

### Data-access seam (`src/store.ts`)
- All Supabase access continues to route through `store.ts` (the single primary seam). Every data function becomes **merchant-scoped**: it takes (or closes over) the active `merchantId` and filters/inserts accordingly.
- Order number generation: `<merchant.order_prefix>-YYYYMMDD-XXXX`, using the per-merchant counter.
- Slug generation lives behind a single function: latin → slugify; Chinese → pinyin transliteration; empty/too-short → `shop-<short-id>`; then collision-suffix (`-2`, `-3`); reject reserved words.

### Routing & context
- Introduce `react-router`. Routes: `/` (marketing+signup), `/s/:slug` (storefront), `/s/:slug/account`, `/merchant/*` (merchant dashboard), `/admin/*` (super-admin).
- Merchant is resolved from `:slug` **once** at the route boundary and provided via a React **MerchantContext**. Components read context; they never re-resolve the merchant. The monolithic `App.tsx` state is decomposed along these route boundaries.

### Security (RLS — mandatory, second seam)
- RLS policies on every tenant table so a merchant (and that merchant's customers) can only read/write rows matching their `merchant_id`; super-admin role bypasses to read all.
- App-layer `merchant_id` filtering is **not** sufficient on its own (public anon key); RLS is the enforcement boundary.

### Onboarding flow
- Merchant signup collects **only shop name** → auto-slug (editable once) → merchant created `pending` → super-admin approves → status `active` → merchant adds products/config in dashboard → storefront live at `/s/:slug`.

### Payments
- Manual, per-merchant. Each merchant's storefront displays that merchant's own payment details. No platform-level payment integration in this PRD.

### Phasing (build order)
P0 schema + RLS · P1 router + role-based access · P2 merchant signup/onboarding · P3 super-admin approval queue · P4 merchant dashboard (port existing owner UI, scoped) · P5 storefront `/s/:slug` + per-merchant Telegram/payment · P6 root marketing page.

## Testing Decisions

- **What makes a good test here:** assert external behaviour, not implementation. For the data layer that means: given an active merchant, store functions return/insert only that merchant's rows; order numbers carry the right prefix and increment per-merchant; slug generation yields expected slug for latin, Chinese (pinyin), empty (fallback), collision, and reserved inputs. Tests must not assert on internal query shapes.
- **Primary tested module — `src/store.ts`** (the single data seam). Slug generation and order-number generation are pure-ish and the highest-value unit tests. Merchant-scoped read/write functions are tested against a test Supabase project (or local Supabase) with two seeded merchants.
- **Tenant isolation — RLS (second seam):** integration tests using two separate authenticated clients (merchant A, merchant B) asserting A cannot read/write B's products/orders/customers, and that super-admin can read all. This is the security-critical test set and cannot be replaced by app-layer tests.
- **Prior art:** none — no test suite exists in the repo today. This PRD introduces the first tests. Recommend **Vitest** for unit tests of `store.ts` pure functions and a separate integration suite (local Supabase) for RLS. Establishing the runner is part of P0.

## Out of Scope

- Migrating existing live BiteTime data into the new schema (explicit fresh start; BiteTime re-onboards as a merchant).
- Platform-level/automated payment processing (Stripe Connect or similar) — payment stays manual per-merchant.
- Subdomain-based storefronts (chose path-slug); revisit later if needed.
- Cross-merchant shopping / unified marketplace cart (customers are per-merchant).
- Merchant slug changes after going live (slug is editable only once, pre-launch).
- Separate auth credentials per shop (rejected; one auth user, profile-per-merchant).
- A merchant directory/discovery page at root (root is marketing+signup).
- Self-serve super-admin onboarding (single platform super-admin).

## Further Notes

- **Biggest hidden cost:** the real work is retrofitting a router onto a no-router app and decomposing the `App.tsx` god-component along route boundaries — not the onboarding form itself. Budget accordingly.
- The hardcoded `OWNER_EMAIL` gate and the `localStorage` caches (`bitetime_settings`, `bitetime_addr_<userId>`) must become merchant-scoped or be removed; stale single-tenant caches will leak across merchants if left as-is.
- Bilingual `t(en, zh)` behaviour and existing product/voucher features (zh product fields, multi-use vouchers, referral rewards, same-day KL/Selangor delivery) must be preserved per-merchant, not dropped in the rewrite.
- Reserved slug blocklist must include every top-level route segment introduced by the router.
