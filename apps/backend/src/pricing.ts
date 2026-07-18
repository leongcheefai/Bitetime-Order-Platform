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
    if (price.currency.toLowerCase() !== 'myr') {
      throw new Error(`Price for ${plan}/${cycle} is ${price.currency.toUpperCase()}, expected MYR`)
    }
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
