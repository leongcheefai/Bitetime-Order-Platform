import Stripe from 'stripe'
import { env } from './env.js'
import { resolvePriceId } from './pricing.js'
import { DEFAULT_REGION, type Region } from './region.js'

export const stripe = new Stripe(env.stripeSecretKey)

const PLANS = ['basic', 'pro']
const CYCLES = ['monthly', 'yearly']

export function isValidPlan(plan: string) {
  return PLANS.includes(plan)
}
export function isValidCycle(cycle: string) {
  return CYCLES.includes(cycle)
}

// Map (plan, cycle, region) → configured Stripe Price ID. Region defaults to the
// platform default so existing callers keep their USD behavior.
export function priceFor(plan: string, cycle: string, region: Region = DEFAULT_REGION) {
  return resolvePriceId(env.prices, plan, cycle, region)
}
