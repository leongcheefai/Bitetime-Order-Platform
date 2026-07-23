# Shop Settings regroup — money out of Shipping

**Date:** 2026-07-23
**Scope:** `apps/frontend/src/merchant/ShopSettings.tsx` only. No backend, no schema, no shared-package change.

## Problem

The **Shipping** tab is one form carrying 7 cards doing three unrelated jobs:

1. **Currency** (top) and **Tax** (near bottom) — money concerns, not shipping.
2. **What customers can choose** (the master method switch) — sits *second*, below Currency.
3. Per-method config — Pickup address, Delivery origin, Delivery rates, Express rates — scattered around Tax rather than grouped under the method that enables them.

Merchant reads it as "everything scattered around."

## Decision

Split by concern. Money leaves Shipping and joins Payment; Shipping becomes pure fulfilment
with the master switch first and each method's config beneath it.

### Shipping tab (after) — pure fulfilment, method-first

One form, one Save. Card order:

1. **What customers can choose** (methods) — moved to top, it is the master switch.
2. **Pickup address** — always rendered (unchanged visibility).
3. **Delivery origin** — always rendered (unchanged visibility).
4. **Delivery rates** — conditional on `deliveryEnabled` (unchanged).
5. **Express delivery rates** — conditional on `expressEnabled` (unchanged).

Save writes: `pickup_enabled`, `delivery_enabled`, `express_enabled`, `pickup_address`,
`shipping` (WM/EM), `delivery_base_fee`, `delivery_rate_per_km`, `delivery_max_km`, origin
fields. **No longer writes `currency`, `tax_enabled`, `tax_rate`.**

Currency-symbol coupling: the rate-input labels and the express example use the currency
symbol. Currency no longer lives in this form, so the symbol reads the **saved** value:
`currencyDef(merchant!.currency ?? DEFAULT_CURRENCY).symbol` instead of `fields.currency`.
Acceptable and arguably better — currency locks after the first order anyway, and the symbol
now reflects what is actually saved.

`ShippingFields` / `saved` / `fields` drop the `currency`, `taxEnabled`, `taxRate` keys.

### Payment tab (after) — the money tab

One form, one Save. Card order:

1. **Currency** — moved from Shipping, carrying its lock logic intact (see below).
2. **Tax** — moved from Shipping, carrying its `shopTax` read/write-back intact.
3. **Bank / payment details** — existing.
4. **Payment note** — existing.

Save writes: `payment_bank`, `payment_note`, plus (moved in) `currency` (gated on lock),
`tax_enabled`, `tax_rate`. Adds `refreshMerchant()` (already present) and the show-back-through-
`shopTax` / saved-currency logic that today lives in `ShippingTab.save`.

Tab label stays **"Payment" / "付款"** — no rename.

## What moves, verbatim, into PaymentTab

- **Currency card** (lines ~312–343): the `Select`, `currencyLocked` state, the
  `merchantHasOrders` effect that sets it, and the lock-copy. Imports `CURRENCIES`,
  `CURRENCY_CODES`, `DEFAULT_CURRENCY`, `currencyDef` follow.
- **Tax card** (lines ~497–528): the checkbox + rate input.
- **Save-time money logic** from `ShippingTab.save`: the `currencyLocked` write-gate
  (`...(currencyLocked ? {} : { currency: fields.currency })`), `tax_enabled`/`tax_rate`,
  and the `shopTax(...)` show-back that keeps the checkbox agreeing with what was stored.

## Dirty tracking — no change needed

`isDirty` (`settingsDirty.ts`) is generic over the union of keys each snapshot populates.
Moving `currency`/`taxEnabled`/`taxRate` out of Shipping's snapshots and into Payment's works
automatically. **Invariant to preserve:** every boolean key (`taxEnabled`) must be present in
BOTH `saved` and `fields` from init, or a missing-vs-`false` compare reads as dirty. PaymentTab
must initialise both snapshots with `taxEnabled`/`taxRate`/`currency`, exactly as ShippingTab
did. No edit to `settingsDirty.ts`.

## Out of scope (explicitly not doing)

- No change to which cards are conditional. Pickup address and Delivery origin stay
  always-rendered; only the two rate cards stay method-gated. Hiding origin/pickup by method is
  a behaviour change and is not part of this.
- No tab renames, no new tabs, no backend/schema/shared change.
- No change to any validation rule, save payload shape, or copy — cards move, wording stays.

## Verification

Per CLAUDE.md, UI is verified by running the app (`verify` skill), not component tests:

1. Shipping tab shows methods first, then pickup address, origin, and the two method-gated rate
   cards. No Currency, no Tax card.
2. Payment tab shows Currency (locked when the shop has orders), Tax, Bank, Payment note.
3. Edit + Save on Payment persists currency (when unlocked) and tax; reload shows them back
   correctly (blank/0 tax → checkbox unticked via `shopTax`).
4. Edit + Save on Shipping persists methods/rates/origin; rate labels show the saved currency
   symbol.
5. Dirty guard still fires: dirty a field on either tab, try to switch tab → blocked.
6. `pnpm typecheck` and `pnpm --filter @bitetime/frontend test` pass.
