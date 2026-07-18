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
