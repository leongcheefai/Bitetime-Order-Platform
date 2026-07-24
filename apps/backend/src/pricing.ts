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
 * The inverse of `priceId`: which tier is this subscription actually paying for? (#112)
 *
 * This is what makes `merchants.plan` money-derived rather than a claim from the signup body.
 * Reading it back off the configured map means no Stripe-side setup can drift — no lookup keys
 * to forget on a price, no product metadata to keep in step. The four ids are already
 * `required()` at boot (see env.ts), so if this returns null the price genuinely is not one of
 * ours.
 *
 * **Null means "change nothing"**, and every caller must honour that. A price made by hand in
 * the dashboard, a legacy price, a currency variant — guessing a tier from one of those, or
 * falling back to 'basic', silently revokes a paying Pro shop's features. A stale column is the
 * cheaper failure. Mirrors `hasProAccess` failing closed.
 */
export function planFromPriceId(prices: Prices, id: string): { plan: Plan; cycle: Cycle } | null {
  if (!id) return null
  for (const plan of PLANS) {
    for (const cycle of CYCLES) {
      // Not `priceId()` — an unconfigured slot must be skipped, not thrown on. This function
      // answers a question about a price we did not choose, so a half-configured env is a
      // no-match, not an error.
      if (prices[`${plan}_${cycle}`] === id) return { plan, cycle }
    }
  }
  return null
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
