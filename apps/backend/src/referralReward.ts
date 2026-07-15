// Pure referral-reward decision. No I/O: the route handler gathers the referred shop's
// code, the candidate referrers matching it, and the payment context; this module decides
// whether — and how much — to credit. Mirrors billingLifecycle.ts / notify.ts: effects stay
// in the webhook handler (Stripe credit + ledger insert), the rule lives here and is tested
// without a database. PRD: docs/prd-referral-reward.md (#70).

import type Stripe from 'stripe'

export interface ReferrerSubscription {
  amount: number // smallest currency unit (cents) — the plan's recurring amount from Stripe
  interval: 'month' | 'year'
  currency: string
}

export interface ReferrerCandidate {
  merchantId: string
  ownerId: string
  billingStatus: string | null // merchant_billing.status
  stripeCustomerId: string | null
  subscription: ReferrerSubscription | null
  paymentFingerprints: string[] // card fingerprints on this customer
}

export interface ReferralRewardInput {
  // The referred shop's merchants.referred_by_code (the referrer's 8-hex code), or null.
  referredByCode: string | null
  // True when referral_rewards already has a row for this referred shop — a later billing
  // cycle, or a webhook retry. The DB primary key is the real guard; this short-circuits
  // before touching Stripe.
  alreadyRewarded: boolean
  // Every merchant whose referral_code equals referredByCode. Usually one; two distinct
  // owners can collide on the 8-hex code, which is exactly why we resolve carefully.
  candidates: ReferrerCandidate[]
  // The referred shop's own payment context, for the self-referral guard.
  referred: { stripeCustomerId: string | null; paymentFingerprints: string[] }
}

export type ReferralSkipReason =
  | 'not_referred' // the shop signed up under no code
  | 'already_rewarded' // idempotency: a reward already exists for this referred shop
  | 'referrer_no_paid_plan' // nobody eligible matched the code (forfeit)
  | 'ambiguous_referrer' // >1 eligible referrer (code collision) — never guess
  | 'self_referral' // referred and referrer share a customer or card

export type ReferralRewardDecision =
  | { grant: true; referrerMerchantId: string; stripeCustomerId: string; amount: number; currency: string }
  | { grant: false; reason: ReferralSkipReason }

// Derive the recurring amount, interval and currency from a Stripe subscription's first
// item. Pure (type-only Stripe import) so it lives with the decision it feeds.
export function subInfoFromStripe(sub: Stripe.Subscription): ReferrerSubscription | null {
  const item = sub.items?.data?.[0]
  const price = item?.price
  const amount = price?.unit_amount
  const interval = price?.recurring?.interval
  if (amount == null || (interval !== 'month' && interval !== 'year')) return null
  return { amount, interval, currency: sub.currency }
}

// One month of a plan. A yearly plan's "one month free" is a literal twelfth of what the
// referrer pays (annual ÷ 12, whole cents) — not the equivalent monthly-plan rate. FR-4.
export function monthlyCreditAmount(sub: ReferrerSubscription): number {
  return sub.interval === 'year' ? Math.round(sub.amount / 12) : sub.amount
}

// An eligible referrer is one actually PAYING — an active subscription with a resolvable
// amount and a customer to credit. Trialing / canceled / past_due are not paid plans, so a
// referrer in those states forfeits (FR-6).
function isEligible(c: ReferrerCandidate): c is ReferrerCandidate & {
  stripeCustomerId: string
  subscription: ReferrerSubscription
} {
  return c.billingStatus === 'active' && c.subscription !== null && c.stripeCustomerId !== null
}

function isSelfReferral(referrer: ReferrerCandidate, referred: ReferralRewardInput['referred']): boolean {
  if (referrer.stripeCustomerId && referrer.stripeCustomerId === referred.stripeCustomerId) return true
  const shared = new Set(referred.paymentFingerprints)
  return referrer.paymentFingerprints.some(fp => shared.has(fp))
}

export function decideReferralReward(input: ReferralRewardInput): ReferralRewardDecision {
  if (!input.referredByCode) return { grant: false, reason: 'not_referred' }
  if (input.alreadyRewarded) return { grant: false, reason: 'already_rewarded' }

  // Filter to paying referrers FIRST, then insist on exactly one: an inactive namesake that
  // happens to share the code must not make a legitimate single referrer look ambiguous.
  const eligible = input.candidates.filter(isEligible)
  if (eligible.length === 0) return { grant: false, reason: 'referrer_no_paid_plan' }
  if (eligible.length > 1) return { grant: false, reason: 'ambiguous_referrer' }

  const referrer = eligible[0]
  if (isSelfReferral(referrer, input.referred)) return { grant: false, reason: 'self_referral' }

  return {
    grant: true,
    referrerMerchantId: referrer.merchantId,
    stripeCustomerId: referrer.stripeCustomerId,
    amount: monthlyCreditAmount(referrer.subscription),
    currency: referrer.subscription.currency,
  }
}
