import Stripe from 'stripe'
import { env } from './env.js'

export const stripe = new Stripe(env.stripeSecretKey)

const PLANS = ['basic', 'pro']
const CYCLES = ['monthly', 'yearly']

export function isValidPlan(plan: string) {
  return PLANS.includes(plan)
}
export function isValidCycle(cycle: string) {
  return CYCLES.includes(cycle)
}

// Map (plan, cycle) → configured Stripe Price ID.
export function priceFor(plan: string, cycle: string) {
  const id = env.prices[`${plan}_${cycle}` as keyof typeof env.prices]
  if (!id) throw new Error(`No price configured for ${plan}/${cycle}`)
  return id
}
