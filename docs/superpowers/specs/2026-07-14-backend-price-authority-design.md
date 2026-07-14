# Backend price authority

**Date:** 2026-07-14
**Issue:** child of #66
**Status:** approved, not yet implemented

## Why

`priceOrder` documents four rules; two never run. #66 asked for a decision on the two
dead inputs (`promoSold`, `referral`). The decision is **build both** — but investigating
the promo half turned up something that has to land first.

Promo is not a half-wired cap. It is absent:

- `products` (`20260627120000_multitenant_schema.sql:62`) has no `promo_price`,
  `promo_limit` or `promo_end` column.
- `Product` (`types.ts:55`) declares none either — `promoPrice`/`promoLimit`/`promoEnd`
  survive only through its `[key: string]: any` index signature and `as any` casts in
  `pricing.ts:129`.
- `ProductsManager.tsx` has no promo field.

So no merchant can set a promo, capped or not. #66's claim that "merchants set a cap
expecting it to bind" is false — nothing about promo is live. It is a legacy
single-tenant leftover, like `referral`.

That changes what the promo cap needs. `placeOrder` takes `items` and `total` **from the
browser body** (`orders.ts:38-41`) and trusts them. While every price is a plain column
that is merely sloppy. The moment a product has a *conditional* price, the browser
asserting it becomes a discount anyone can mint with `curl` — and a quantity cap enforced
in the browser is decorative. `claimVoucher`'s own comment already sets the house
standard: *"a cap that only holds when nobody is racing it is not a cap."*

So the promo feature needs the backend to be the price authority. That is this spec.
It ships **before** promo, on its own, because it is independently valuable and
independently testable: it closes a live hole where any client can `POST` `total: 0` and
have the order commit.

## Design

### The seam

`apps/frontend/src/pricing.ts` moves to `@bitetime/shared`.

It qualifies exactly as CLAUDE.md defines that package: *a rule that must hold identically
on both sides of the wire*. The browser prices to **show** a total; the backend prices to
**charge** one. Two copies of the rounding, the discount order, or the shipping-region
selection would drift, and the drift would surface as a customer being charged a number
they did not see. One module, both sides.

Moving with it:

- `voucherFromRow` (today `store.ts:432`) — the `vouchers` row → domain mapping is part of
  the rule, not a frontend detail. Both sides must read a voucher row the same way or the
  discount math diverges on shape alone.
- `EM_STATES`, `shippingFee`, `voucherError`, `effectivePrice` — the whole module.

`@bitetime/shared` ships TypeScript source with no build step, so both consumers compile
it themselves. Per CLAUDE.md: if this adds a backend **runtime** dependency, its
`--external:` esbuild flag must be added too. None is expected — `pricing.ts` is pure.

### The wire

`POST /api/orders` stops accepting prices. The body becomes cart + context:

```
{ merchantId, customerName, customerWa, mode, address,
  cart: { [productId]: qty },
  voucherCode, voucherEntry,
  quotedTotal }
```

Removed from the body — every one of these is now **derived from Postgres**:

| Was in body | Now derived from |
|---|---|
| `items` | `products` rows for the cart's ids |
| `total` | shared `priceOrder()` |
| `shippingFee` | `merchants.shipping` jsonb (`{WM, EM}`) + mode/state |
| `discount` | the claimed voucher |
| `currency` | `merchants.currency` |

`quotedTotal` is the number the customer saw on screen. It is a **confirmation to check,
not an input to trust** — the order never commits at the browser's number, only at the
backend's, and only when the two agree.

### Inside the transaction

`placeOrder` keeps its shape (one transaction, whole or nothing). New steps, in order:

1. `assertOrderableMerchant` — unchanged, and now also returns `shipping` and `currency`.
2. Load the cart's products: `select … from products where merchant_id = $1 and id = any($2) and active`.
   Any requested id missing from the result → `product_unavailable`.
3. Counter, then voucher claim — unchanged, and in that order, for the deadlock-freedom
   reason already documented there.
4. Call the shared `priceOrder()` with a **server clock** and the rows just loaded.
5. Compare the computed total against `quotedTotal` **in cents** (both are already
   `round2`'d; compare exact). Mismatch → `price_changed`.
6. Insert the order with the **backend's** `items`, `shipping_fee`, `discount`, `total`,
   `currency`.

Tenancy stays a TypeScript invariant, not a Postgres one — `db.ts` is RLS-exempt, so step
2's `merchant_id = $1` predicate is the only thing keeping a stranger's product out of
this cart. It is load-bearing.

### Refusals

Two new `OrderErrorCode`s. Per the comment at `orders.ts:9` they are a wire contract and
must be twinned into `store.ts`'s `OrderErrorCode` **and** given a customer-facing message,
or the customer is told "something went wrong" for a refusal whose reason we know.

- **`price_changed`** — computed total ≠ `quotedTotal`. The transaction rolls back. The
  Storefront re-prices, shows the new total, and asks the customer to confirm. This is the
  same retry shape the voucher refusal already uses. The customer is **never charged a
  number they did not agree to** — which is the whole point, and is what makes a promo
  selling out mid-checkout a choice rather than a surprise.
- **`product_unavailable`** — a cart id is not this merchant's, or is not active.

### Testing

- The pure math keeps its unit tests, which move with the module to `packages/shared`.
- `apps/backend/tests/api/` gains real-Postgres cases (never mocked, per CLAUDE.md):
  - a body claiming `total: 0` is refused, and no order row is written;
  - a price edited between quote and submit refuses with `price_changed`;
  - a product id belonging to another merchant, or inactive, refuses with
    `product_unavailable`;
  - the committed row's `total` equals the server's math, not anything the body said.
- UI is verified by running the app (run-and-verify), per CLAUDE.md — not component tests.

### Docs

`CONTEXT.md` → **Order pricing** gains the price-authority statement: the Storefront's
`priceOrder` call is a quote for display, the backend's is the charge, and they are the
same module for that reason. Its "these two rules do not currently run" caveat stays until
Issues B and C land — it is still true today.

## Out of scope

Named here so they are not lost:

- **Issue B — promo feature.** `promo_price` / `promo_limit` / `promo_end` /
  `promo_sold` columns, ProductsManager fields, Storefront badge, and the cap enforced by
  incrementing `promo_sold` under `select … for update` inside this transaction — the
  claimVoucher pattern. `promo_sold` is a counter, not a scan of `orders.items` (which is
  what the dropped `product_sales()` did): atomic, O(1), lockable. Its cost is that a
  cancelled order never returns its units to the cap; the merchant resets the count when
  they edit the promo. Small once this spec has landed, because the price is already
  server-derived.
- **Issue C — referral discount.** Bigger than #66 implies, and needs a PRD. The legacy
  program (`71ade60:apps/frontend/src/components/OrderForm.jsx:92`) was two-sided: a
  first-order discount for the referred customer, gated by `is_new_customer` (dropped in
  #62), **and** a free gift product for the referrer, shipped with their next order and
  confirmed by the merchant on the Orders page (`settings.referral = { enabled, discount,
  giftProductId }`). It also derived a customer's code as the first 8 hex of their user id
  — the **same derivation as the merchant referral-capture code**, so the two share a
  namespace. None of that is a wiring job.
- **Three more dead rules, same disease as #66.** `vouchers` has no `min_order`,
  `expires_at` or `email` column, so `voucherError`'s `min_order`, `expired` and
  `not_assigned` branches can never fire — and `Storefront.tsx:227` renders a
  minimum-order refusal message that is unreachable. Worth its own ticket.
- **`sameday` mode, `samedayFee`, `extraLines`** — also unreachable from the Storefront
  (`Storefront.tsx:71` offers `'pickup' | 'delivery'` only). Left alone deliberately: #66's
  scope is the two inputs it names.
