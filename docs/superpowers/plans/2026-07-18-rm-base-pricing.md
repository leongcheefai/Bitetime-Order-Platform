# RM-base Pricing with Local Estimates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Charge every platform subscription in MYR (one Stripe Price set) and show visitors the real RM price plus a labelled approximate local-currency estimate.

**Architecture:** Two separated concerns. **Charging**: collapse the per-region Stripe Price machinery to a single MYR set — `priceFor(plan, cycle)` with no region. **Display**: a pure hardcoded-FX module (`fx.ts`) turns the visitor's detected country into a `{ currency, rate }` estimate (or `null` for Malaysia); `/api/pricing` returns the MYR base (read live from Stripe) plus that estimate; the frontend renders `RM x.xx` + `≈ local`.

**Tech Stack:** Hono + Stripe (backend, TypeScript, NodeNext, `.js` specifiers), Vitest, React 19 + Vite + Tailwind (frontend), `postgres.js` unaffected.

## Global Constraints

- Backend imports keep `.js` specifiers resolving to `.ts` source (NodeNext) — leave them as `.js`.
- The RM base price is read from Stripe (`unit_amount` minor → major ÷ 100) so displayed RM never drifts from charged RM. Do not hardcode the base amount anywhere except `FALLBACK_PRICING`.
- Estimate currencies must exist in the frontend currency registry (`apps/frontend/src/currency.ts`: `MYR, SGD, USD, THB, PHP, IDR, VND, JPY`) or `formatMoney` falls back to RM. Do not add a country whose currency is absent from that registry without adding the registry entry too.
- The estimate is display-only and clearly approximate (`≈`); it is never what Stripe charges.
- `merchants.billing_region` column stays (no migration); it is always written `'MY'`.
- Localisation: user-facing strings use `t(en, zh)`.

---

### Task 1: FX module (`fx.ts`)

Pure, self-contained. Nothing imports it yet, so the build stays green.

**Files:**
- Create: `apps/backend/src/fx.ts`
- Test: `apps/backend/tests/unit/fx.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `estimateFor(country: string): { currency: string; rate: number } | null`, plus `COUNTRY_TO_CURRENCY: Record<string,string>` and `MYR_RATES: Record<string,number>` and `interface Estimate { currency: string; rate: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backend/tests/unit/fx.test.ts
import { describe, it, expect } from 'vitest'
import { estimateFor, COUNTRY_TO_CURRENCY, MYR_RATES } from '../../src/fx.js'

describe('estimateFor', () => {
  it('returns null for Malaysia (RM is already their currency)', () => {
    expect(estimateFor('MY')).toBeNull()
  })

  it('maps a listed country to its currency and MYR rate', () => {
    expect(estimateFor('SG')).toEqual({ currency: 'SGD', rate: MYR_RATES.SGD })
  })

  it('falls back to a USD estimate for an unlisted country', () => {
    expect(estimateFor('GB')).toEqual({ currency: 'USD', rate: MYR_RATES.USD })
  })

  it('falls back to USD for an empty/undetected country', () => {
    expect(estimateFor('')).toEqual({ currency: 'USD', rate: MYR_RATES.USD })
  })

  it('is case-insensitive and trims', () => {
    expect(estimateFor(' sg ')).toEqual({ currency: 'SGD', rate: MYR_RATES.SGD })
    expect(estimateFor(' my ')).toBeNull()
  })

  it('has a MYR rate for every mapped currency', () => {
    for (const currency of Object.values(COUNTRY_TO_CURRENCY)) {
      expect(typeof MYR_RATES[currency]).toBe('number')
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bitetime/backend test fx`
Expected: FAIL — cannot find module `../../src/fx.js`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/backend/src/fx.ts
// Display-only FX for the platform pricing page. RM (MYR) is the price we actually
// charge everyone; these rates convert that RM amount into an APPROXIMATE local
// figure shown as a courtesy (`≈`), never charged. Hardcoded on purpose: no API,
// no key, deterministic — nudge the numbers in a PR when they drift.
//
// Every currency here must exist in the frontend currency registry
// (apps/frontend/src/currency.ts) or formatMoney falls back to RM.

// Approximate units of the target currency per 1 MYR.
export const MYR_RATES: Record<string, number> = {
  USD: 0.21,
  SGD: 0.29,
  THB: 7.6,
  PHP: 12.5,
  IDR: 3400,
  VND: 5500,
  JPY: 33,
}

// ISO 3166-1 alpha-2 country → estimate currency. Malaysia is deliberately absent:
// Malaysians see the real RM price with no estimate line. Anything unlisted falls
// back to a USD estimate.
export const COUNTRY_TO_CURRENCY: Record<string, string> = {
  SG: 'SGD',
  TH: 'THB',
  PH: 'PHP',
  ID: 'IDR',
  VN: 'VND',
  JP: 'JPY',
  US: 'USD',
}

export interface Estimate {
  currency: string
  rate: number
}

/**
 * The local-currency estimate for a visitor's country, or `null` when none should
 * be shown. `MY` → null (RM is already their currency). A mapped country → its
 * currency + MYR rate. Anything else (including an empty/undetected country) → a
 * USD estimate. Never throws.
 */
export function estimateFor(country: string): Estimate | null {
  const code = (country ?? '').trim().toUpperCase()
  if (code === 'MY') return null
  const currency = COUNTRY_TO_CURRENCY[code] ?? 'USD'
  return { currency, rate: MYR_RATES[currency] }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bitetime/backend test fx`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/fx.ts apps/backend/tests/unit/fx.test.ts
git commit -m "feat(pricing): hardcoded FX table for local-currency estimates (#81)"
```

---

### Task 2: Backend charging collapse + country detection + pricing route

One atomic refactor: the region abstraction cannot be half-removed (`env.prices`, `pricing.ts`, `stripe.ts`, `region.ts`, and the three `app.ts` routes all reference it), so they change together and the task ends with all backend unit tests green and `typecheck` clean. TDD the two pure modules first, then wire the impure route/checkout code, then verify by running the app (the `/api/pricing` route reads Stripe live, so it is covered by run-and-verify in Task 4, not an in-process api test).

**Files:**
- Rewrite: `apps/backend/src/region.ts` (billing-region mapping → `detectCountry`)
- Rewrite: `apps/backend/src/pricing.ts` (`resolvePriceId`/`fetchRegionPricing` → `priceId`/`fetchBasePricing`)
- Modify: `apps/backend/src/env.ts:34-46` (nested-by-region `prices` → flat MYR set)
- Modify: `apps/backend/src/stripe.ts` (`priceFor(plan, cycle)`)
- Modify: `apps/backend/src/app.ts` (imports; `/api/pricing`; `createMerchant`, `/api/checkout`, trial-create)
- Rewrite test: `apps/backend/tests/unit/region.test.ts`
- Rewrite test: `apps/backend/tests/unit/pricing.test.ts`

**Interfaces:**
- Consumes: `estimateFor` from Task 1.
- Produces:
  - `region.ts`: `detectCountry({ explicitCountry?: string; getHeader: (name: string) => string | undefined }): string`
  - `pricing.ts`: `priceId(prices: Prices, plan: string, cycle: string): string`; `fetchBasePricing(deps: { prices: Prices; retrievePrice: (id: string) => Promise<{ unit_amount: number | null; currency: string }> }): Promise<PricingPayload>`; `type Prices = Record<string, string>`; `interface PricingPayload { currency: string; prices: Record<'basic'|'pro', Record<'monthly'|'yearly', number>> }`; `createPricingCache` (unchanged signature).
  - `stripe.ts`: `priceFor(plan: string, cycle: string): string`
  - `env.ts`: `env.prices: Record<string, string>` (flat, keys `basic_monthly` … `pro_yearly`).

- [ ] **Step 1: Rewrite the `region.ts` test (red)**

```ts
// apps/backend/tests/unit/region.test.ts
import { describe, it, expect } from 'vitest'
import { detectCountry } from '../../src/region.js'

const noHeaders = () => undefined

describe('detectCountry', () => {
  it('returns empty string when nothing is given', () => {
    expect(detectCountry({ getHeader: noHeaders })).toBe('')
  })

  it('reads the cf-ipcountry header', () => {
    const getHeader = (n: string) => (n === 'cf-ipcountry' ? 'MY' : undefined)
    expect(detectCountry({ getHeader })).toBe('MY')
  })

  it('lets an explicit country override the header', () => {
    const getHeader = (n: string) => (n === 'cf-ipcountry' ? 'US' : undefined)
    expect(detectCountry({ explicitCountry: 'SG', getHeader })).toBe('SG')
  })

  it('uppercases and trims', () => {
    expect(detectCountry({ explicitCountry: ' sg ', getHeader: noHeaders })).toBe('SG')
  })

  it('prefers cf-ipcountry over later headers', () => {
    const getHeader = (n: string) =>
      n === 'cf-ipcountry' ? 'MY' : n === 'x-country-code' ? 'US' : undefined
    expect(detectCountry({ getHeader })).toBe('MY')
  })

  it('falls through to x-country-code when earlier headers are absent', () => {
    const getHeader = (n: string) => (n === 'x-country-code' ? 'ID' : undefined)
    expect(detectCountry({ getHeader })).toBe('ID')
  })
})
```

- [ ] **Step 2: Rewrite `region.ts` (green for detectCountry)**

Replace the entire file contents:

```ts
// apps/backend/src/region.ts
// Geo detection for the pricing page. We charge MYR everywhere, so there are no
// billing "regions" any more — this only resolves the visitor's country so the
// display layer can pick an approximate local-currency estimate (see fx.ts).

// CDN-provided country headers, in precedence order (first present wins).
const COUNTRY_HEADERS = ['cf-ipcountry', 'x-vercel-ip-country', 'x-country-code']

/**
 * Resolve the visitor's ISO 3166-1 alpha-2 country. Precedence: an explicit
 * country (the `?country=` override) beats CDN headers, which beat nothing.
 * Returns '' when undetected. Pure — the caller supplies a header accessor.
 */
export function detectCountry({
  explicitCountry,
  getHeader,
}: {
  explicitCountry?: string
  getHeader: (name: string) => string | undefined
}): string {
  const explicit = (explicitCountry ?? '').trim()
  if (explicit) return explicit.toUpperCase()
  for (const name of COUNTRY_HEADERS) {
    const value = getHeader(name)
    if (value) return value.trim().toUpperCase()
  }
  return ''
}
```

- [ ] **Step 3: Rewrite the `pricing.ts` test (red)**

```ts
// apps/backend/tests/unit/pricing.test.ts
import { describe, it, expect, vi } from 'vitest'
import { priceId, fetchBasePricing, createPricingCache } from '../../src/pricing.js'

const PRICES = {
  basic_monthly: 'p_bm', basic_yearly: 'p_by', pro_monthly: 'p_pm', pro_yearly: 'p_py',
}

describe('priceId', () => {
  it('resolves the configured price id', () => {
    expect(priceId(PRICES, 'basic', 'monthly')).toBe('p_bm')
    expect(priceId(PRICES, 'pro', 'yearly')).toBe('p_py')
  })

  it('throws when a price is not configured', () => {
    expect(() => priceId({ ...PRICES, pro_yearly: '' }, 'pro', 'yearly')).toThrow(/pro\/yearly/)
  })
})

const AMOUNTS: Record<string, number> = {
  p_bm: 990, p_by: 9900, p_pm: 3990, p_py: 39900,
}
const retrievePrice = async (id: string) => ({ unit_amount: AMOUNTS[id], currency: 'myr' })

describe('fetchBasePricing', () => {
  it('returns MYR currency and major-unit amounts read from Stripe', async () => {
    const payload = await fetchBasePricing({ prices: PRICES, retrievePrice })
    expect(payload).toEqual({
      currency: 'MYR',
      prices: {
        basic: { monthly: 9.9, yearly: 99 },
        pro: { monthly: 39.9, yearly: 399 },
      },
    })
  })
})

describe('createPricingCache', () => {
  it('caches within the TTL and reloads after it', async () => {
    let t = 0
    const cache = createPricingCache<number>({ ttlMs: 100, now: () => t })
    const loader = vi.fn(async () => 42)
    expect(await cache.get('k', loader)).toBe(42)
    t = 50
    expect(await cache.get('k', loader)).toBe(42)
    expect(loader).toHaveBeenCalledTimes(1)
    t = 200
    await cache.get('k', loader)
    expect(loader).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 4: Rewrite `pricing.ts` (green)**

Replace the entire file contents:

```ts
// apps/backend/src/pricing.ts
// Platform subscription pricing. Everyone is charged in MYR, so there is one Stripe
// Price set — amounts are read from the actual Stripe Prices so the displayed price
// can never drift from what is charged. Pure and dependency-injected.

const PLANS = ['basic', 'pro'] as const
const CYCLES = ['monthly', 'yearly'] as const
type Plan = (typeof PLANS)[number]
type Cycle = (typeof CYCLES)[number]

// `${plan}_${cycle}` → Stripe Price ID (MYR). A missing/empty id is "not configured".
export type Prices = Record<string, string>

export interface PricingPayload {
  currency: string
  prices: Record<Plan, Record<Cycle, number>>
}

/** Look up the Stripe Price ID for a (plan, cycle). Throws if absent. */
export function priceId(prices: Prices, plan: string, cycle: string): string {
  const id = prices[`${plan}_${cycle}`]
  if (!id) throw new Error(`No price configured for ${plan}/${cycle}`)
  return id
}

/**
 * Build the pricing payload: read each plan×cycle amount from Stripe (`unit_amount`
 * is minor units, converted to major) and stamp the MYR currency.
 */
export async function fetchBasePricing(deps: {
  prices: Prices
  retrievePrice: (id: string) => Promise<{ unit_amount: number | null; currency: string }>
}): Promise<PricingPayload> {
  const amountOf = async (plan: Plan, cycle: Cycle) => {
    const price = await deps.retrievePrice(priceId(deps.prices, plan, cycle))
    return (price.unit_amount ?? 0) / 100
  }

  const prices = {} as Record<Plan, Record<Cycle, number>>
  for (const plan of PLANS) {
    prices[plan] = {} as Record<Cycle, number>
    for (const cycle of CYCLES) {
      prices[plan][cycle] = await amountOf(plan, cycle)
    }
  }

  return { currency: 'MYR', prices }
}

/**
 * Tiny per-key TTL cache so landing-page traffic does not hit Stripe on every
 * view. Clock is injected for deterministic tests.
 */
export function createPricingCache<T>({ ttlMs, now }: { ttlMs: number; now: () => number }) {
  const store = new Map<string, { at: number; value: T }>()
  return {
    async get(key: string, loader: () => Promise<T>): Promise<T> {
      const hit = store.get(key)
      if (hit && now() - hit.at < ttlMs) return hit.value
      const value = await loader()
      store.set(key, { at: now(), value })
      return value
    },
  }
}
```

- [ ] **Step 5: Flatten `env.ts` prices to a single MYR set**

In `apps/backend/src/env.ts`, replace the `prices:` block (lines ~30-47) with:

```ts
  // Stripe Price IDs (MYR), keyed by `${plan}_${cycle}`. We charge MYR for every
  // subscription, so there is one set and all four are required. Point these at
  // your MYR Prices.
  prices: {
    basic_monthly: required('STRIPE_PRICE_BASIC_MONTHLY'),
    basic_yearly: required('STRIPE_PRICE_BASIC_YEARLY'),
    pro_monthly: required('STRIPE_PRICE_PRO_MONTHLY'),
    pro_yearly: required('STRIPE_PRICE_PRO_YEARLY'),
  },
```

- [ ] **Step 6: Simplify `stripe.ts`**

In `apps/backend/src/stripe.ts`: change the import and `priceFor`, and drop the `region` import.

```ts
import Stripe from 'stripe'
import { env } from './env.js'
import { priceId } from './pricing.js'

export const stripe = new Stripe(env.stripeSecretKey)

const PLANS = ['basic', 'pro']
const CYCLES = ['monthly', 'yearly']

export function isValidPlan(plan: string) {
  return PLANS.includes(plan)
}
export function isValidCycle(cycle: string) {
  return CYCLES.includes(cycle)
}

// Map (plan, cycle) → the configured MYR Stripe Price ID. We charge MYR for everyone.
export function priceFor(plan: string, cycle: string) {
  return priceId(env.prices, plan, cycle)
}
```

- [ ] **Step 7: Update `app.ts` imports and the `/api/pricing` route**

Replace the two region/pricing imports (`app.ts:26-27`) with:

```ts
import { detectCountry } from './region.js'
import { fetchBasePricing, createPricingCache, type PricingPayload } from './pricing.js'
import { estimateFor } from './fx.js'
```

Replace the `/api/pricing` route (`app.ts:58-81`) with:

```ts
const pricingCache = createPricingCache<PricingPayload>({ ttlMs: 5 * 60_000, now: () => Date.now() })

app.get('/api/pricing', async (c) => {
  const country = detectCountry({
    explicitCountry: c.req.query('country') || undefined,
    getHeader: (name) => c.req.header(name),
  })
  try {
    // Base MYR prices are the same for everyone → cached under one key; the estimate
    // is a cheap pure lookup that varies by country, so it is not cached.
    const base = await pricingCache.get('base', () =>
      fetchBasePricing({
        prices: env.prices,
        retrievePrice: (id) =>
          stripe.prices
            .retrieve(id)
            .then((p) => ({ unit_amount: p.unit_amount, currency: p.currency })),
      }),
    )
    return c.json({ ...base, estimate: estimateFor(country) })
  } catch (err) {
    console.error('Pricing resolution failed:', err instanceof Error ? err.message : String(err))
    return c.json({ error: 'Pricing unavailable' }, 502)
  }
})
```

- [ ] **Step 8: Drop region from the three charging routes in `app.ts`**

In `createMerchant` (`app.ts:118`): change

```ts
      billing_region: body?.region ?? 'US',
```
to
```ts
      billing_region: 'MY', // everyone is charged MYR
```

In `/api/checkout` (`app.ts:395-458`): remove the `region` line (`app.ts:401-402`), and change the metadata + line item:

```ts
  const metadata = { merchant_id: merchant.id, plan, billing, region: 'MY' }
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceFor(plan, billing), quantity: 1 }],
```

In the trial-create route (`app.ts:517`, `541`, `544`): remove the `const region = isValidRegion(...)` line, and change

```ts
    sub = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceFor(plan, cycle) }],
      trial_period_days: 7,
      trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
      metadata: { merchant_id: merchant.id, plan, billing: cycle, region: 'MY' },
    })
```

- [ ] **Step 9: Run backend unit tests + typecheck**

Run: `pnpm --filter @bitetime/backend test && pnpm typecheck`
Expected: PASS — `fx`, `region`, `pricing`, `notify` unit suites green; no `tsc` errors (confirms no dangling `detectRegion`/`isValidRegion`/`REGION_CURRENCY`/`resolvePriceId`/`fetchRegionPricing`/`Region` references remain).

- [ ] **Step 10: Commit**

```bash
git add apps/backend/src/region.ts apps/backend/src/pricing.ts apps/backend/src/env.ts apps/backend/src/stripe.ts apps/backend/src/app.ts apps/backend/tests/unit/region.test.ts apps/backend/tests/unit/pricing.test.ts
git commit -m "feat(pricing): charge MYR for everyone; /api/pricing returns RM base + local estimate (#81)"
```

---

### Task 3: Frontend — RM base + estimate rendering

**Files:**
- Modify: `apps/frontend/src/store.ts:207-214` (`PlatformPricing` type), `:180` (`createMerchant`), `:188` (`startCheckout`)
- Modify: `apps/frontend/src/usePlatformPricing.ts` (`FALLBACK_PRICING`)
- Modify: `apps/frontend/src/marketing/Landing.tsx` (price render + CTA link)
- Modify: `apps/frontend/src/merchant/SignupScreen.tsx` (price render + submit calls)

**Interfaces:**
- Consumes: `/api/pricing` shape from Task 2 — `{ currency: string; prices: {basic:{monthly,yearly}, pro:{monthly,yearly}}; estimate: {currency,rate}|null }`.
- Produces: `PlatformPricing` with `estimate: { currency: string; rate: number } | null` and no `region`; `createMerchant`/`startCheckout` without a `region` param.

- [ ] **Step 1: Update the `PlatformPricing` type + store call signatures**

In `apps/frontend/src/store.ts`, replace the `PlatformPricing` interface (`:207-214`) with:

```ts
export interface PlatformPricing {
  currency: string
  prices: {
    basic: { monthly: number; yearly: number }
    pro: { monthly: number; yearly: number }
  }
  estimate: { currency: string; rate: number } | null
}
```

Change `createMerchant` (`:180`) to drop `region`:

```ts
export async function createMerchant({ name, plan = 'basic', billing = 'monthly', referredByCode }: { name: string; plan?: string; billing?: string; referredByCode?: string }) {
```
(Remove `region` from the destructure and from the request body it builds a few lines below — delete the `region` property from the POSTed JSON.)

Change `startCheckout` (`:188`) to drop `region`:

```ts
export async function startCheckout({ plan, billing }: { plan: string; billing: string }) {
```
(Remove `region` from the POSTed JSON body.)

- [ ] **Step 2: Update `FALLBACK_PRICING` to MYR**

In `apps/frontend/src/usePlatformPricing.ts`, replace `FALLBACK_PRICING`:

```ts
// Last-resort pricing so the marketing/signup pages always render a sensible RM
// price if the backend is slow or unavailable. Real amounts come from Stripe.
export const FALLBACK_PRICING: PlatformPricing = {
  currency: 'MYR',
  prices: {
    basic: { monthly: 9.9, yearly: 99 },
    pro: { monthly: 39.9, yearly: 399 },
  },
  estimate: null,
}
```

- [ ] **Step 3: Update the Landing page price render + CTA link**

In `apps/frontend/src/marketing/Landing.tsx`, replace the price `<div>` (`:331-334`) with the base price followed by the estimate line:

```tsx
                <div className="flex items-baseline gap-[0.35rem] mt-3">
                  <span className="font-heading text-[34px] font-semibold text-oxblood leading-none">{formatMoney(amount, pricing.currency)}</span>
                  <span className="text-sm text-rose-muted">{t('/mo', '/月')}</span>
                </div>
                {pricing.estimate && amount > 0 && (
                  <p className="text-xs text-rose-muted mt-1 mb-0">
                    ≈ {formatMoney(amount * pricing.estimate.rate, pricing.estimate.currency)}{t('/mo', '/月')}
                  </p>
                )}
```

Change the CTA `Link` (`:352`) to drop `&region=`:

```tsx
                  to={`${tier.to}?plan=${tier.id}&billing=${billing}`}
```

- [ ] **Step 4: Update the SignupScreen banner + submit calls**

In `apps/frontend/src/merchant/SignupScreen.tsx`:

Change the two submit calls (`:57`, `:67`) to drop `region: pricing.region`:

```ts
      await createMerchant({ name, plan, billing, referredByCode: ref })
```
```ts
      const url = await startCheckout({ plan, billing })
```

In the plan banner, after the price `<span>` (`:88`), add the estimate:

```tsx
          <span className="font-heading text-ink text-[15px]">{formatMoney(perMoAmount, pricing.currency)}{t('/mo', '/月')}</span>
          {pricing.estimate && perMoAmount > 0 && (
            <span className="text-rose-muted text-[13px]">≈ {formatMoney(perMoAmount * pricing.estimate.rate, pricing.estimate.currency)}{t('/mo', '/月')}</span>
          )}
```

- [ ] **Step 5: Typecheck the frontend**

Run: `pnpm typecheck`
Expected: PASS — no references to `pricing.region` remain, no `region` args passed to `createMerchant`/`startCheckout`.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/store.ts apps/frontend/src/usePlatformPricing.ts apps/frontend/src/marketing/Landing.tsx apps/frontend/src/merchant/SignupScreen.tsx
git commit -m "feat(pricing): landing/signup show RM base + local estimate (#81)"
```

---

### Task 4: Run-and-verify

Per CLAUDE.md, UI is verified by running the app. This also exercises the live `/api/pricing` route (which reads Stripe and so is not covered by an in-process api test). Requires the backend's MYR `STRIPE_PRICE_*` env vars to point at real MYR Prices.

**Files:** none (verification only).

- [ ] **Step 1: Start the app**

Run: `pnpm dev` (frontend :5173, backend :8787).

- [ ] **Step 2: Verify Malaysia sees RM only**

Open `http://localhost:5173/?country=MY`. Confirm each plan shows `RM x.xx/mo` with **no** `≈` estimate line.

- [ ] **Step 3: Verify a mapped country shows the estimate**

Open `http://localhost:5173/?country=SG`. Confirm each plan shows `RM x.xx/mo` **and** a muted `≈ S$y.yy/mo` line.

- [ ] **Step 4: Verify an unmapped country falls back to USD**

Open `http://localhost:5173/?country=GB`. Confirm the estimate line reads `≈ $y.yy/mo` (USD).

- [ ] **Step 5: Verify the signup banner + checkout hand-off**

From `/?country=SG`, click a plan CTA. Confirm the signup URL carries `?plan=…&billing=…` (no `region=`) and the plan banner shows `RM …/mo ≈ S$…/mo`. Confirm the Pro checkout hand-off still reaches Stripe (billed MYR).

- [ ] **Step 6: Run the full test + lint gate**

Run: `pnpm test && pnpm lint && pnpm typecheck`
Expected: all PASS.

---

## Self-Review

**Spec coverage:**
- Charge MYR for everyone → Task 2 (env flatten, `priceFor(plan,cycle)`, three routes write `region:'MY'`). ✓
- Display RM base + labelled estimate → Task 3 (Landing + Signup render). ✓
- Hardcoded FX table → Task 1 (`fx.ts`). ✓
- Country→currency, MY→null, unknown→USD → Task 1 (`estimateFor`) + Task 2 (`detectCountry`). ✓
- Stripe is the RM amount source of truth → Task 2 (`fetchBasePricing` reads `unit_amount` live). ✓
- `billing_region` kept, always `'MY'`, no migration → Task 2 Step 8. ✓
- FALLBACK is MYR → Task 3 Step 2. ✓
- Out of scope (existing US subs, no FX API, no per-country Prices) → honored; nothing touches existing subscriptions. ✓

**Deviation from spec:** the spec listed an in-process `tests/api` case for `/api/pricing`. That route reads Stripe over the network, and the `test:db` config stubs Stripe with fake keys, so an in-process call would fail at `stripe.prices.retrieve`. The route is thin composition over three unit-tested pure functions (`detectCountry`, `fetchBasePricing`, `estimateFor`); it is verified live in Task 4 instead. Unit coverage of the pieces is unchanged.

**Placeholder scan:** no TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `detectCountry`, `priceId`, `fetchBasePricing`, `Prices`, `PricingPayload`, `priceFor(plan,cycle)`, `estimateFor`, and `PlatformPricing.estimate` names/shapes match across Tasks 1-3. ✓
