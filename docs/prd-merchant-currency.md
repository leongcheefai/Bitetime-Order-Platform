# PRD — Merchant-Selectable Base Currency

Status: ready-for-agent
Author: synthesized from `/grill-me` session (2026-06-30)
Related: [[db-code-drift]], [[order-pricing-module]], [[stripe-billing]]

## Problem Statement

Every price in the app is hardcoded as Malaysian Ringgit (`RM`). A merchant
outside Malaysia — Singapore, Thailand, Indonesia, Philippines — cannot run a
storefront that shows their own currency. Customers see "RM" on products,
shipping, vouchers, order totals, and the Telegram receipt regardless of where
the shop operates. The platform is implicitly Malaysia-only.

Separately, the marketing landing page and merchant signup screen display
SaaS plan prices as `RM 9.99` / `RM 39.99`, but those numbers are actually the
USD amounts charged via Stripe. Customers are shown a wrong currency label on
the price they pay the platform.

## Solution

A merchant picks a **base currency** for their shop. That currency is the unit
for the prices they set (products, shipping rates, voucher values) and for
everything their customers see in the storefront and order receipt. Existing
merchants stay on Ringgit by default — nothing changes for them unless they
choose another currency.

The currency is **display + pricing-unit only**. It does not change how the
merchant pays the platform for the SaaS subscription (that stays in one fixed
currency, USD, via Stripe), and there is no foreign-exchange conversion: a
price the merchant types is the price the customer pays, in the chosen
currency's symbol and formatting.

The merchant can choose their currency freely **until their first order is
placed**, after which it is locked — so historical orders, dashboard totals,
and customer expectations never silently re-denominate.

The platform billing surfaces (landing page pricing, signup screen) are
corrected to display **USD**, matching what Stripe actually charges.

## User Stories

1. As a merchant outside Malaysia, I want to choose my shop's base currency, so that my prices and my customers' totals show the right money.
2. As a merchant, I want my product prices to display in my chosen currency, so that customers aren't confused by a foreign symbol.
3. As a merchant, I want my shipping rates (West/East region fees) labelled in my currency, so that delivery costs read correctly.
4. As a merchant, I want my voucher discounts (fixed-amount) shown in my currency, so that promotions are unambiguous.
5. As a merchant, I want the price-input fields in my dashboard to show my currency symbol, so that I know the unit I'm typing in.
6. As a merchant, I want my currency to default to Ringgit, so that existing Malaysian shops are unaffected and require no action.
7. As a merchant, I want to change my currency freely before I take any orders, so that I can correct a wrong initial choice during setup.
8. As a merchant, I want my currency to lock after my first order, so that my past orders and dashboard totals stay consistent in one unit.
9. As a merchant, I want a clear, disabled state and explanation when currency is locked, so that I understand why I can't change it.
10. As a customer, I want product prices in the storefront shown in the shop's currency, so that I know what I'll pay.
11. As a customer, I want the delivery fee, subtotal, discount, and total in the order summary shown in the shop's currency, so that the checkout math is clear.
12. As a customer, I want the order-success confirmation amounts in the shop's currency, so that my receipt matches what I agreed to.
13. As a customer, I want correct decimal handling for the currency (e.g. no `.00` cents on yen/rupiah), so that prices look native and trustworthy.
14. As a merchant, I want my Telegram order notification to show amounts in my currency, so that my fulfilment view matches the customer's.
15. As a merchant placing my first order on a new shop, I want each order to record the currency it was placed in, so that the figure is never reinterpreted later.
16. As a platform operator, I want a fixed list of supported currencies, so that formatting (decimals, symbol position) is correct and controlled rather than free-text.
17. As a prospective merchant on the landing page, I want SaaS plan prices shown in the currency I'll actually be charged (USD), so that pricing isn't misleading.
18. As a signing-up merchant, I want the plan price on the signup screen shown in USD, so that it matches the Stripe charge.
19. As a Malaysian merchant, I want `RM` formatting preserved exactly as today when my currency is Ringgit, so that nothing regresses.
20. As a merchant, I want one consistent money format across storefront, dashboard, and receipt, so that the experience feels coherent.

## Implementation Decisions

### Scope boundary (locked in grilling)
- **Option A only — display + pricing unit.** No FX conversion, no change to
  Stripe charge currency, no payout/reconciliation logic. The platform SaaS
  subscription stays one fixed currency (USD).

### New module — currency registry + formatter (the single seam)
- New pure module `src/currency.ts`:
  - A **fixed enum/registry** of supported currencies, seeded with ~8 common
    SEA + global currencies (e.g. MYR, SGD, USD, THB, IDR, PHP, VND, plus
    room to extend). Each entry carries at minimum `{ code, symbol, decimals }`
    (and symbol position where it differs).
  - `formatMoney(amount, code)` — the **one** function every display site calls.
    Implemented with `Intl.NumberFormat` so decimals, thousands separators, and
    symbol position are correct per currency without hand-rolling. `decimals`
    from the registry drives fraction digits (MYR=2, JPY/IDR/VND=0).
- This module is the highest seam: all money rendering flows through it. No raw
  `RM ${n.toFixed(2)}` strings remain anywhere.

### Pricing module unchanged
- `src/pricing.ts` keeps operating on bare numbers — currency is a display
  concern, totals math is currency-agnostic. `priceOrder()` and `voucherError()`
  are not modified. Only the *rendering* of their outputs changes.

### Schema changes
- `merchants.currency text not null default 'MYR'` — dedicated column alongside
  `shipping` (NOT inside the `config` jsonb bag; it is queried, frozen per
  order, and surfaced in UI). Storefront and backend already read the merchants
  row, so existing anon RLS on active shops covers it.
- `orders.currency text` — stamped at order placement, frozen forever. Default
  null tolerated for legacy rows; new orders always set it.
- Note: the legacy single-tenant `settings` (key/value) table is **not** used —
  per-merchant config now lives on the `merchants` row.

### Order placement
- `placeOrder()` writes `currency` onto the inserted order row, sourced from the
  active merchant's `merchants.currency` at placement time. Order receipt and
  dashboard read the order's own stamped currency, not the merchant's current
  setting.

### Merchant settings UI
- `ShopSettings.tsx` (which edits the `merchants` row) gains a currency
  dropdown populated from the fixed registry.
- The dropdown is **disabled/locked once the merchant has ≥1 order**, with a
  short explanation. Requires an order-existence check for that merchant.
- Price/shipping input labels (`Price (RM)`, `West Malaysia (RM)`, etc.) become
  dynamic — symbol/code from the selected currency.

### Storefront + dashboard display
- All money render sites switch to `formatMoney`:
  storefront (product price, delivery-mode label, order summary subtotal/fee/
  discount/total, order-success amounts, voucher labels), merchant dashboard
  (`OrdersView` order total, `Overview` money formatter, `ProductsManager`
  price, `VouchersManager` fixed-value label).
- Dashboard money uses the relevant currency consistently (merchant's current
  currency for aggregates; an order's stamped currency where a single order is
  shown). Because currency is locked after the first order, aggregate totals
  never mix currencies.

### Backend Telegram notification
- `notify.ts` formats item line totals, shipping fee, and order total using the
  order's currency (passed through / read server-side from the merchant row).
  No `RM` literal remains.

### Platform billing relabel
- Landing page (`Landing.tsx`) and signup screen (`SignupScreen.tsx`) change the
  plan-price display from `RM {price}` to **USD**, matching the Stripe charge.
  This is a label/format fix; the underlying plan amounts are unchanged.

### Out-of-scope locale note
- `en-MY` locale used for **date/time** formatting (`OrdersView`, `Overview`) is
  unrelated to currency and is left as-is.

## Testing Decisions

A good test here verifies **external behaviour** — what string a given
(amount, currency) renders to, and what the Telegram payload contains — not the
internal shape of the registry.

- **`src/currency.ts` → `src/currency.test.ts` (new, primary).** Pure unit
  tests. Cover: MYR renders `RM 8.00` (2 decimals, symbol-before) identically to
  today; a 0-decimal currency (JPY/IDR) renders without cents; thousands
  separator on large amounts; each seeded currency formats without throwing.
  Prior art: existing pure unit tests in `apps/frontend/src/*.test.ts`
  (`pricing.ts` test pattern).
- **Backend `notify.ts` → `apps/backend/tests/unit/notify.test.ts` (update).**
  Existing assertions hardcode `RM 10.00` / `Total: RM 18.00`. Update to assert
  currency-aware output (parameterise expected strings by the order's currency).
  Prior art: the existing notify unit test itself.
- **Order currency freeze** (`placeOrder` stamping `orders.currency`) is
  Supabase-dependent; verify in the RLS/integration test layer
  (`apps/backend/tests/rls/`) or by run-and-verify, not as a pure unit test.
- **UI** (currency dropdown, lock-after-first-order, storefront/dashboard
  rendering) is verified by **run-and-verify** (dev server + browser), per
  CLAUDE.md — no component-test framework.

## Out of Scope

- Foreign-exchange / currency conversion of any kind.
- Charging the SaaS subscription in the merchant's currency (Stripe stays USD).
- Multi-currency per single shop (one base currency per merchant).
- Changing currency after the first order (locked by design).
- Migrating or re-denominating historical order amounts.
- `en-MY` date/time locale formatting (separate concern, untouched).
- Per-customer currency selection / customer-side currency switching.

## Further Notes

- Default `'MYR'` guarantees zero behaviour change for existing Malaysian
  merchants — the rollout is silent for them.
- The whole feature hinges on one new pure module (`currency.ts`); the rest is a
  mechanical sweep replacing ~20 raw `RM ${...}.toFixed(2)` sites with
  `formatMoney`. Keeping that sweep behind one function is what keeps the change
  honest and testable.
- Suggested phasing: (P0) schema + `currency.ts` + unit tests; (P1) replace all
  frontend render sites; (P2) ShopSettings dropdown + order-count lock + freeze
  on `placeOrder`; (P3) backend `notify.ts` + test update; (P4) Landing/Signup
  RM→USD relabel.
