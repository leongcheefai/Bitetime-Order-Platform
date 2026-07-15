// I/O glue for the referral reward. The DECISION is pure (referralReward.ts, unit-tested);
// this module gathers the Stripe + Supabase facts that feed it and applies the effect (a
// customer-balance credit + a ledger row). It imports `admin` and `stripe` directly, like
// billing.ts / notify.ts — the tested surface is the pure decision plus subInfoFromStripe.
// PRD: docs/prd-referral-reward.md (#70).

import { admin } from './supabase.js'
import { stripe } from './stripe.js'
import {
  decideReferralReward,
  subInfoFromStripe,
  type ReferralRewardDecision,
  type ReferrerCandidate,
  type ReferrerSubscription,
} from './referralReward.js'

// Best-effort card fingerprints on a customer — the self-referral guard's second signal.
// A Stripe hiccup here must not block a legitimate reward, so failures degrade to [].
async function cardFingerprints(customerId: string | null): Promise<string[]> {
  if (!customerId) return []
  try {
    const pms = await stripe.paymentMethods.list({ customer: customerId, type: 'card' })
    return pms.data.map(pm => pm.card?.fingerprint).filter((f): f is string => !!f)
  } catch {
    return []
  }
}

async function candidateFrom(merchant: { id: string; owner_id: string | null }): Promise<ReferrerCandidate> {
  const { data: billing } = await admin
    .from('merchant_billing')
    .select('status, stripe_customer_id, stripe_subscription_id')
    .eq('merchant_id', merchant.id)
    .maybeSingle()

  const stripeCustomerId = billing?.stripe_customer_id ?? null
  const subId = billing?.stripe_subscription_id ?? null

  let subscription: ReferrerSubscription | null = null
  if (subId) {
    try {
      const sub = await stripe.subscriptions.retrieve(subId)
      subscription = subInfoFromStripe(sub)
    } catch {
      subscription = null
    }
  }

  return {
    merchantId: merchant.id,
    ownerId: merchant.owner_id ?? '',
    billingStatus: billing?.status ?? null,
    stripeCustomerId,
    subscription,
    paymentFingerprints: await cardFingerprints(stripeCustomerId),
  }
}

// Apply a granted reward: credit the referrer's Stripe customer balance, then record the
// ledger row with the returned transaction id. Stripe first, so the ledger only ever claims
// credits that actually happened; the ledger PK makes a retry after a partial success safe.
async function applyReferralReward(
  referredMerchantId: string,
  grant: Extract<ReferralRewardDecision, { grant: true }>,
): Promise<void> {
  // Negative amount = a credit on the customer balance, consumed against future invoices.
  const txn = await stripe.customers.createBalanceTransaction(grant.stripeCustomerId, {
    amount: -grant.amount,
    currency: grant.currency,
    description: `Referral reward: one month free (referred merchant ${referredMerchantId})`,
  })

  const { error } = await admin.from('referral_rewards').insert({
    referred_merchant_id: referredMerchantId,
    referrer_merchant_id: grant.referrerMerchantId,
    amount: grant.amount,
    currency: grant.currency,
    stripe_customer_id: grant.stripeCustomerId,
    stripe_balance_txn_id: txn.id,
  })
  if (error) throw error
}

// Full orchestration for one referred merchant's first paid invoice: gather → decide →
// (maybe) credit + record. Returns the decision so the webhook can log the outcome.
export async function processReferralReward(referredMerchantId: string): Promise<ReferralRewardDecision> {
  const { data: referred } = await admin
    .from('merchants')
    .select('id, referred_by_code')
    .eq('id', referredMerchantId)
    .maybeSingle()
  if (!referred) return { grant: false, reason: 'not_referred' }

  const referredByCode = referred.referred_by_code ?? null

  const { data: existingReward } = await admin
    .from('referral_rewards')
    .select('referred_merchant_id')
    .eq('referred_merchant_id', referredMerchantId)
    .maybeSingle()
  const alreadyRewarded = !!existingReward

  // Only look up candidates and payment context when there is a code and no prior reward —
  // the common "not referred" invoice does zero extra Stripe/DB work.
  let candidates: ReferrerCandidate[] = []
  let referredCustomerId: string | null = null
  let referredFingerprints: string[] = []
  if (referredByCode && !alreadyRewarded) {
    const { data: matches } = await admin
      .from('merchants')
      .select('id, owner_id')
      .eq('referral_code', referredByCode)
    candidates = await Promise.all((matches ?? []).map(candidateFrom))

    const { data: referredBilling } = await admin
      .from('merchant_billing')
      .select('stripe_customer_id')
      .eq('merchant_id', referredMerchantId)
      .maybeSingle()
    referredCustomerId = referredBilling?.stripe_customer_id ?? null
    referredFingerprints = await cardFingerprints(referredCustomerId)
  }

  const decision = decideReferralReward({
    referredByCode,
    alreadyRewarded,
    candidates,
    referred: { stripeCustomerId: referredCustomerId, paymentFingerprints: referredFingerprints },
  })
  if (decision.grant) await applyReferralReward(referredMerchantId, decision)
  return decision
}
