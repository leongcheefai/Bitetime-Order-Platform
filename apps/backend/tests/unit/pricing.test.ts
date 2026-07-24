import { describe, it, expect, vi } from 'vitest'
import { priceId, planFromPriceId, fetchBasePricing, createPricingCache } from '../../src/pricing.js'

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

// The inverse of priceId (#112). This is how the webhook learns what tier a shop is actually
// paying for: `merchants.plan` stops being the signup body's claim and becomes whatever price
// is on the live subscription.
describe('planFromPriceId', () => {
  it('resolves every configured price back to its plan and cycle', () => {
    expect(planFromPriceId(PRICES, 'p_bm')).toEqual({ plan: 'basic', cycle: 'monthly' })
    expect(planFromPriceId(PRICES, 'p_by')).toEqual({ plan: 'basic', cycle: 'yearly' })
    expect(planFromPriceId(PRICES, 'p_pm')).toEqual({ plan: 'pro', cycle: 'monthly' })
    expect(planFromPriceId(PRICES, 'p_py')).toEqual({ plan: 'pro', cycle: 'yearly' })
  })

  // Load-bearing: an unrecognised price must change NOTHING. A price made by hand in the
  // dashboard, a legacy price, a currency variant — guessing here, or defaulting to 'basic',
  // silently revokes a paying Pro shop's features, which is far worse than a stale column.
  // The caller's contract is "null means leave the row alone" (mirrors hasProAccess failing closed).
  it('returns null for a price it does not recognise, rather than guessing', () => {
    expect(planFromPriceId(PRICES, 'price_made_by_hand')).toBeNull()
    expect(planFromPriceId(PRICES, '')).toBeNull()
  })

  // An unconfigured slot is an empty string in `Prices`; it must never match an empty/absent id
  // and hand back a tier nobody bought.
  it('never matches an empty configured slot', () => {
    expect(planFromPriceId({ ...PRICES, pro_yearly: '' }, '')).toBeNull()
  })

  it('ignores keys that are not a plan_cycle pair', () => {
    expect(planFromPriceId({ ...PRICES, legacy_thing: 'p_x' }, 'p_x')).toBeNull()
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

  it('rejects when a retrieved Stripe Price is not MYR', async () => {
    const usdRetrieve = async (id: string) => ({
      unit_amount: AMOUNTS[id],
      currency: id === 'p_pm' ? 'usd' : 'myr',
    })
    await expect(fetchBasePricing({ prices: PRICES, retrievePrice: usdRetrieve })).rejects.toThrow(
      /pro\/monthly is USD, expected MYR/,
    )
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
