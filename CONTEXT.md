# Domain glossary

Names for the load-bearing concepts in the ordering app. Use these terms in code, tests, and reviews.

## Order pricing

The deep, pure module (`apps/frontend/src/pricing.ts`) that turns a cart + context into a money breakdown. Single source of truth for every total the app shows. Owns shipping-region selection, promo price resolution, voucher discount, and referral discount — in that order. No I/O: the clock, the loaded voucher, the sameday quote, and the resolved referral are all passed in.

- **`priceOrder(input) -> PriceBreakdown`** — the one interface. Both the storefront and the legacy order form call it. Returns `{ lines, subtotal, shipping, discount, referralDiscount, total }`. The `lines` carry resolved unit prices so the success screen and the Telegram message consume the breakdown instead of re-deriving it.
- **`voucherError(voucher, ctx) -> string | null`** — pure voucher rules (expiry, `usedBy`, assignment, `minOrder` gate). Loading the codes stays I/O in the caller; the rules are testable without a network.
- **`effectivePrice(product, now)`** — promo resolution (`promoActive` by date/limit). Storefront historically ignored promos; folding it here closes that drift.

Discount order is load-bearing: voucher applies to items+shipping, then referral applies to the post-voucher total (`min(amount, totalAfterVoucher)`). Rounding is `parseFloat(toFixed(2))` per step.

## Order intake

The flow that collects a cart and customer details and commits an order: `collect → priceOrder → placeOrder → notifyOrder`. Two intake paths exist today — the multi-tenant **Storefront** (`store/Storefront.tsx`) and the legacy single-tenant **order form** (`components/OrderForm.tsx`); unifying them depends on Order pricing landing first.

## Voucher

A per-merchant promotion code. `percent` (subtotal×value/100) or fixed (`min(value, total)`). Validation rules live in `voucherError`; the discount math lives in `priceOrder`.

## Referral

A discount earned by referring a new customer. Capped at the post-voucher total. The cap math is in `priceOrder`; the referrer lookup and new-customer check are I/O in the caller (`fetchProfileByReferralCode`, `isNewCustomer`).
