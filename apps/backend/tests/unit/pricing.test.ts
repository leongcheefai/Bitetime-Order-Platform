import { describe, it, expect, vi } from 'vitest'
import { resolvePriceId, fetchRegionPricing, createPricingCache } from '../../src/pricing.js'

const PRICES = {
  US: { basic_monthly: 'p_bm_us', basic_yearly: 'p_by_us', pro_monthly: 'p_pm_us', pro_yearly: 'p_py_us' },
  MY: { basic_monthly: 'p_bm_my', basic_yearly: 'p_by_my', pro_monthly: 'p_pm_my', pro_yearly: '' },
} as const

describe('resolvePriceId', () => {
  it('resolves the region-specific price id', () => {
    expect(resolvePriceId(PRICES, 'basic', 'monthly', 'MY')).toBe('p_bm_my')
    expect(resolvePriceId(PRICES, 'basic', 'monthly', 'US')).toBe('p_bm_us')
  })

  it('throws when a region has no configured price', () => {
    expect(() => resolvePriceId(PRICES, 'pro', 'yearly', 'MY')).toThrow(/pro\/yearly\/MY/)
  })
})

const AMOUNTS: Record<string, number> = {
  p_bm_us: 999, p_by_us: 9990, p_pm_us: 3999, p_py_us: 39990,
  p_bm_my: 4990, p_by_my: 49900, p_pm_my: 19900, p_py_my: 199000,
}
const retrievePrice = async (id: string) => ({ unit_amount: AMOUNTS[id], currency: 'ignored' })

describe('fetchRegionPricing', () => {
  it('returns the region currency and major-unit amounts read from Stripe', async () => {
    const prices = { ...PRICES, MY: { ...PRICES.MY, pro_yearly: 'p_py_my' } }
    const payload = await fetchRegionPricing('MY', { prices, retrievePrice })
    expect(payload).toEqual({
      region: 'MY',
      currency: 'MYR',
      prices: {
        basic: { monthly: 49.9, yearly: 499 },
        pro: { monthly: 199, yearly: 1990 },
      },
    })
  })

  it('uses USD for the default region', async () => {
    const payload = await fetchRegionPricing('US', { prices: PRICES, retrievePrice })
    expect(payload.currency).toBe('USD')
    expect(payload.prices.basic.monthly).toBe(9.99)
    expect(payload.prices.pro.yearly).toBe(399.9)
  })
})

describe('createPricingCache', () => {
  it('serves a cached value within the TTL without reloading', async () => {
    const cache = createPricingCache<{ v: number }>({ ttlMs: 500, now: () => 1000 })
    const loader = vi.fn(async () => ({ v: 1 }))
    const a = await cache.get('MY', loader)
    const b = await cache.get('MY', loader)
    expect(a).toBe(b)
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('reloads after the TTL expires', async () => {
    let now = 1000
    const cache = createPricingCache<{ v: number }>({ ttlMs: 500, now: () => now })
    const loader = vi.fn(async () => ({ v: now }))
    await cache.get('MY', loader)
    now = 1600
    await cache.get('MY', loader)
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('caches each region independently', async () => {
    const cache = createPricingCache<{ r: string }>({ ttlMs: 500, now: () => 1000 })
    const loader = vi.fn(async () => ({ r: 'x' }))
    await cache.get('US', loader)
    await cache.get('MY', loader)
    expect(loader).toHaveBeenCalledTimes(2)
  })
})
