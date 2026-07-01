// Platform subscription pricing, resolved per billing region. Amounts are read
// from the actual Stripe Prices so the displayed price can never drift from what
// is charged. Pure and dependency-injected — the Stripe client and clock are
// passed in, keeping this unit-testable without env vars or network I/O.

import { type Region, REGION_CURRENCY } from './region.js'

const PLANS = ['basic', 'pro'] as const
const CYCLES = ['monthly', 'yearly'] as const
type Plan = (typeof PLANS)[number]
type Cycle = (typeof CYCLES)[number]

// region → `${plan}_${cycle}` → Stripe Price ID. A missing/empty id is treated
// as "not configured" for that region.
export type RegionPrices = Record<Region, Record<string, string>>

export interface PricingPayload {
  region: Region
  currency: string
  prices: Record<Plan, Record<Cycle, number>>
}

/** Look up the Stripe Price ID for a (plan, cycle) in a region. Throws if absent. */
export function resolvePriceId(
  prices: RegionPrices,
  plan: string,
  cycle: string,
  region: Region,
): string {
  const id = prices[region]?.[`${plan}_${cycle}`]
  if (!id) throw new Error(`No price configured for ${plan}/${cycle}/${region}`)
  return id
}

/**
 * Build the pricing payload for a region: read each plan×cycle amount from Stripe
 * (`unit_amount` is minor units, converted to major) and stamp the region currency.
 */
export async function fetchRegionPricing(
  region: Region,
  deps: {
    prices: RegionPrices
    retrievePrice: (id: string) => Promise<{ unit_amount: number | null; currency: string }>
  },
): Promise<PricingPayload> {
  const amountOf = async (plan: Plan, cycle: Cycle) => {
    const price = await deps.retrievePrice(resolvePriceId(deps.prices, plan, cycle, region))
    return (price.unit_amount ?? 0) / 100
  }

  const prices = {} as Record<Plan, Record<Cycle, number>>
  for (const plan of PLANS) {
    prices[plan] = {} as Record<Cycle, number>
    for (const cycle of CYCLES) {
      prices[plan][cycle] = await amountOf(plan, cycle)
    }
  }

  return { region, currency: REGION_CURRENCY[region], prices }
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
