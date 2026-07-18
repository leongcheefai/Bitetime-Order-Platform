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
