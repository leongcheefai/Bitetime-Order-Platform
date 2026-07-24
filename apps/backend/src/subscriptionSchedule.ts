// Building the two phases that step a subscription down a tier at the end of the period it has
// already been paid for.
//
// Stripe's Subscription Update API has no way to defer a price change — it swaps immediately and
// argues about proration. A Subscription Schedule is the mechanism that can say "this price
// until the period ends, then that one", so the downgrade route wraps the live subscription in
// one (`subscriptionSchedules.create({ from_subscription })`) and rewrites its phases with what
// this module returns.
//
// Pure and Stripe-free on purpose: this is the arithmetic that decides how much of a merchant's
// paid period survives, and it must be assertable without a network call. Everything that talks
// to Stripe stays in app.ts.
import type Stripe from 'stripe'

/** Raised for a request that cannot be scheduled — the route turns these into 4xx, never 500. */
export class ScheduleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScheduleError'
  }
}

/**
 * The phase Stripe copies off the live subscription — `schedule.phases[0]` right after
 * `create({ from_subscription })`. Only the fields this module reads are declared; the real
 * object carries far more.
 */
export interface LivePhase {
  start_date: number
  end_date: number | null
  trial_end?: number | null
  items: Array<{ price?: string | { id: string } | null }>
}

const priceIdOf = (item: LivePhase['items'][number]): string | null => {
  const price = item?.price
  if (!price) return null
  return typeof price === 'string' ? price : price.id
}

/**
 * Two phases: the period the merchant has paid for, untouched, then one period at `targetPriceId`.
 *
 * Phase 0 is a faithful copy rather than a fresh phase, and that is the load-bearing part. Stripe
 * replaces the whole phase list on update, so anything omitted here is dropped — a rebuilt phase
 * without `trial_end` ends the trial, and one without the original `start_date` moves the billing
 * anchor. The merchant asked to change what happens NEXT period; nothing about this one may move.
 *
 * Phase 1 runs for a single billing period. The caller pairs that with `end_behavior: 'release'`,
 * so once the swap has happened the schedule lets go and the subscription continues as an
 * ordinary one at the new price — no schedule left attached to complicate the next change.
 *
 * `proration_behavior: 'none'` throughout: the swap lands on a period boundary, so there is
 * nothing to prorate and any credit Stripe invented would be real money moving for no reason.
 */
export function downgradePhases(
  current: LivePhase,
  targetPriceId: string,
): Stripe.SubscriptionScheduleUpdateParams.Phase[] {
  const currentPrice = current.items?.length ? priceIdOf(current.items[0]) : null
  if (!currentPrice) {
    throw new ScheduleError('The current subscription phase carries no price')
  }
  if (!current.end_date) {
    // Without a period end there is no boundary to schedule against, and inventing one would
    // move the merchant's renewal date.
    throw new ScheduleError('The current subscription phase has no end date')
  }
  if (currentPrice === targetPriceId) {
    // A no-op change would still leave a schedule attached to the subscription, which then has
    // to be released before anything else can modify it.
    throw new ScheduleError('The subscription already carries that price')
  }

  const now: Stripe.SubscriptionScheduleUpdateParams.Phase = {
    items: [{ price: currentPrice, quantity: 1 }],
    start_date: current.start_date,
    end_date: current.end_date,
    proration_behavior: 'none',
  }
  // Spread rather than assign null: Stripe reads a present `trial_end` of null as "no trial",
  // which is the same early-ending bug this guards against.
  if (current.trial_end) now.trial_end = current.trial_end

  return [
    now,
    {
      items: [{ price: targetPriceId, quantity: 1 }],
      iterations: 1,
      proration_behavior: 'none',
    },
  ]
}
