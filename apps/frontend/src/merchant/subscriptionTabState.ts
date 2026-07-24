// Pure state derivation for the Settings → Subscription tab (#112).
// Mirrors billingBannerState's discipline: the billing row, the entitled plan and the clock go
// in, a decision comes out. The component renders; this module decides.
//
// Deliberately NOT an extension of billingBannerState. That module answers "must I interrupt the
// merchant?", so a healthy subscription is `none` there and the banner stays silent — an
// invariant its own comment defends. This one answers "what is this shop's subscription?", where
// healthy is the most important answer of all. Same payload, different question.
import type { BillingSnapshot } from './billingBannerState'

// Extends the banner's snapshot rather than restating it: both read the same `merchant_billing`
// row, and two hand-maintained copies of one payload shape drift.
export interface SubscriptionSnapshot extends BillingSnapshot {
  stripe_customer_id?: string | null
  current_period_end?: string | null
}

/**
 * Two independent questions, and conflating them is what made the first cut of this tab wrong:
 *
 * `canManage` — is there a Stripe subscription to act on? It gates the portal BUTTON, because
 * `POST /api/billing/portal` 404s without a customer. It is true for a Pro shop too: Pro cannot
 * upgrade but must still be able to change its card, read invoices, or step back down.
 *
 * `canUpgrade` — is this shop not Pro? It gates the PITCH (price + feature list), which a shop
 * deserves to see even with no subscription behind it: a Pro lock's CTA promised exactly that,
 * and a comped shop landing on a blank tab is the CTA lying.
 */
export type SubscriptionState =
  | { kind: 'none'; plan: string; canUpgrade: boolean; canManage: false }
  | { kind: 'trial'; plan: string; daysLeft: number; trialEndsAt: string; canUpgrade: boolean; canManage: true }
  | { kind: 'live'; plan: string; renewsAt: string | null; canUpgrade: boolean; canManage: true }
  | { kind: 'past-due'; plan: string; canUpgrade: false; canManage: true }

const DAY = 24 * 60 * 60 * 1000

// Statuses where a subscription is actually running. `canceled`/`incomplete` are deliberately
// absent: SuspendedScreen owns reactivation via Checkout, and a second payment path on this tab
// would compete with it.
const LIVE = ['trialing', 'active', 'past_due']

export function subscriptionTabState(
  billing: SubscriptionSnapshot | null | undefined,
  plan: string | null | undefined,
  now: Date,
): SubscriptionState {
  const tier = plan === 'pro' ? 'pro' : 'basic'
  const customer = billing?.stripe_customer_id
  const status = billing?.status ?? null

  // No customer, or nothing running: there is no subscription to manage or change here.
  // A comped Pro shop lands here too — entitled, with no Stripe behind it — which is why the
  // entitled tier is still reported rather than assumed to be basic.
  const canUpgrade = tier !== 'pro'

  if (!customer || !status || !LIVE.includes(status)) {
    return { kind: 'none', plan: tier, canUpgrade, canManage: false }
  }

  // Past due: the card is the problem, not the tier. The pitch stays hidden — answering a
  // question the merchant did not ask while their shop is days from suspension — but the portal
  // button is exactly what they need.
  if (status === 'past_due') {
    return { kind: 'past-due', plan: tier, canUpgrade: false, canManage: true }
  }

  if (status === 'trialing' && billing?.trial_ends_at) {
    const msLeft = Math.max(0, new Date(billing.trial_ends_at).getTime() - now.getTime())
    return {
      kind: 'trial',
      plan: tier,
      daysLeft: Math.floor(msLeft / DAY),
      trialEndsAt: billing.trial_ends_at,
      canUpgrade,
      canManage: true,
    }
  }

  return {
    kind: 'live',
    plan: tier,
    renewsAt: billing?.current_period_end ?? null,
    canUpgrade,
    canManage: true,
  }
}
