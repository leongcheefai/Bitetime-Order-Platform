# RM-base platform pricing with local-currency estimates

**Issue:** [#81](https://github.com/leongcheefai/Bitetime-Order-Platform/issues/81) — landing page subscription pricing not showing correctly.
**Date:** 2026-07-18

## Problem

The platform targets the Malaysia market and prices subscriptions in RM (MYR). Today's
pricing model (see `docs/superpowers/specs/…location-based-pricing`, memory
`location-based-platform-pricing`) treats **US/USD as the default region** and MY as the
special case, with a **real Stripe Price per region and no FX**. Consequences:

- A Malaysian visitor is correctly priced only if the operator created MYR Stripe Prices
  and a CDN sets a country header; otherwise everyone falls back to **USD**.
- Every other country (SG, ID, UK, …) sees **USD**, never their own currency and never RM.

Issue #81 flips the intent: **RM is the base and true price**, and visitors elsewhere
should see an *equivalent amount* in a currency they recognise.

## Decisions (locked with the user)

1. **Charge in RM for everyone.** Stripe bills MYR for all subscriptions. There is one
   MYR Stripe Price set — the per-region Stripe Price machinery collapses.
2. **Display = RM real price + a labelled local-currency estimate.** The estimate is a
   courtesy, clearly approximate (`≈`), never what is charged.
3. **FX rates are a hardcoded, committed table** (MYR → currency). No FX API, no key, no
   network, deterministic and unit-testable. Nudged in a PR occasionally.
4. **Currency is picked from the visitor's country** (existing CDN-header geo + `?country=`
   override). Malaysia → RM only, no estimate line. A country **not in the table falls
   back to a USD estimate**.
5. **Stripe stays the amount source of truth** for the RM base — the displayed RM is read
   from the same MYR Price that is charged, so it can never drift.

## Architecture

Two concerns, kept separate: **charging** (what Stripe bills) and **display** (what the
landing/signup pages show).

### Charging → always MYR

- **`env.ts`**: the `required()` price set becomes the four **MYR** Stripe Price IDs
  (`STRIPE_PRICE_BASIC_MONTHLY` … now hold MYR Price IDs). The nested-by-region `prices`
  object and the optional `*_MYR` vars are removed — one flat set.
- **`priceFor(plan, billing)`**: drop the `region` parameter; always resolves the MYR
  price. (`app.ts:447` checkout, `app.ts:541` trial-create.)
- **Checkout / trial-create / signup**: stop reading `body.region` for price selection.
  The `merchants.billing_region` column is kept (no migration, no webhook churn) but is
  always written `'MY'`. Subscription/session metadata keeps `region: 'MY'`.
- **Frontend**: CTA links drop `&region=…`.

### Display → RM + estimate

- **`fx.ts`** (new, pure): 
  - `COUNTRY_TO_CURRENCY: Record<string, string>` — e.g. `SG→SGD, ID→IDR, TH→THB,
    PH→PHP, VN→VND, GB→GBP, AU→AUD, IN→INR, US→USD`. (Starter set; additive.)
  - `MYR_RATES: Record<string, number>` — approximate MYR→currency multipliers, one per
    currency above.
  - `estimateFor(country: string): { currency: string; rate: number } | null` —
    `MY` → `null` (no estimate); a country in the map → its currency + rate; anything else
    → USD estimate. Fully unit-tested (TDD).
- **`region.ts`** → slimmed to geo detection only: `detectCountry({ explicitCountry,
  getHeader }): string` returns the ISO-3166 alpha-2 country (or `''`), preserving the CDN
  header precedence (`cf-ipcountry` › `x-vercel-ip-country` › `x-country-code`) and the
  `?country=` override. The billing-region mapping (`REGIONS`, `COUNTRY_TO_REGION`,
  `REGION_CURRENCY`, `isValidRegion`, `DEFAULT_REGION`) is removed.
- **`pricing.ts`** → `fetchBasePricing(deps)` reads the single MYR Stripe Price set and
  returns MYR major-unit amounts. `RegionPrices`, the `region` param, and `resolvePriceId`'s
  region argument are dropped. `createPricingCache` stays (one cached base payload; the
  estimate is a cheap pure lookup, not cached).

### `GET /api/pricing`

```jsonc
{
  "currency": "MYR",
  "prices": {
    "basic": { "monthly": 9.9,  "yearly": 99.0  },
    "pro":   { "monthly": 39.9, "yearly": 399.0 }
  },
  "estimate": { "currency": "SGD", "rate": 0.29 }   // or null for MY / when unresolved
}
```

Flow: `detectCountry` → cached base MYR prices (read from Stripe) + `estimateFor(country)`.

### Frontend

- `usePlatformPricing` / `store.fetchPlatformPricing`: type gains `estimate`. `FALLBACK_PRICING`
  becomes MYR (`currency: 'MYR'`, RM amounts, `estimate: null`).
- `Landing.tsx` (and the merchant `SignupScreen`, which shares the hook): render the base
  via the existing `formatMoney(amount, 'MYR')` seam → `RM 9.90/mo`. When `estimate` is
  non-null, render a second, muted line `≈ ${formatMoney(amount * estimate.rate,
  estimate.currency)}`. MY visitors (`estimate: null`) see RM only.

## Error handling

- `/api/pricing` failure → frontend keeps `FALLBACK_PRICING` (MYR, `estimate: null`): the
  page always renders a sensible RM price, no estimate line.
- `estimateFor` never throws; an unknown country yields the USD estimate, and `MY` yields
  `null`. The estimate is presentational, so a stale rate degrades to a slightly-off
  approximation, never a wrong charge.

## Testing

- **`fx.test.ts`** (TDD, pure): `MY → null`; a mapped country → its `{currency, rate}`;
  an unmapped country → USD; currency/rate consistency for every `COUNTRY_TO_CURRENCY` key.
- **`region.test.ts`**: `detectCountry` header precedence + `?country=` override + empty.
- **`pricing.test.ts`**: `fetchBasePricing` reads MYR amounts, minor→major conversion.
- **`tests/api` `/api/pricing`**: MY country → RM, `estimate: null`; SG → RM + SGD estimate;
  unknown → RM + USD estimate.
- **Run-and-verify** (per CLAUDE.md, UI is verified by running the app): landing page with
  `?country=MY`, `?country=SG`, `?country=GB` shows the expected lines.

## Out of scope

- Existing US/USD subscribers keep their current Stripe price; this changes **new signups
  and display** only.
- No FX API, no per-country Stripe Prices, no `billing_region` migration.
