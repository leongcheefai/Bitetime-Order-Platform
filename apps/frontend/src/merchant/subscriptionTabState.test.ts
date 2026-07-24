import { describe, it, expect } from 'vitest'
import { subscriptionTabState } from './subscriptionTabState'

const NOW = new Date('2026-08-01T00:00:00Z')

describe('subscriptionTabState', () => {
  // The state the whole issue exists to reach: a basic shop that CAN be sold Pro. It has a
  // Stripe customer, so the portal is a real destination rather than a 404.
  it('offers the upgrade when a basic shop has a live subscription', () => {
    const state = subscriptionTabState(
      { status: 'active', stripe_customer_id: 'cus_1', current_period_end: '2026-09-01T00:00:00Z' },
      'basic',
      NOW,
    )
    expect(state).toMatchObject({ kind: 'live', plan: 'basic', canUpgrade: true, canManage: true })
  })

  it('does not offer an upgrade to a shop already on pro', () => {
    const state = subscriptionTabState(
      { status: 'active', stripe_customer_id: 'cus_1', current_period_end: '2026-09-01T00:00:00Z' },
      'pro',
      NOW,
    )
    expect(state).toMatchObject({ kind: 'live', plan: 'pro', canUpgrade: false, canManage: true })
  })

  // The dead end that started this: no Stripe customer means the portal answers 404, so the
  // button must not be offered at all. A comped shop is the real-world case.
  it('offers no portal button when there is no billing account', () => {
    expect(subscriptionTabState(null, 'basic', NOW)).toMatchObject({ kind: 'none', canManage: false })
    expect(subscriptionTabState({ status: null, stripe_customer_id: null }, 'pro', NOW))
      .toMatchObject({ kind: 'none', canManage: false })
  })

  // An active shop with no live subscription CAN buy one outright — /api/checkout refuses only
  // trialing/active/past_due, the exact set `canManage` covers. Reachable in production:
  // approve-merchant activates a shop without a subscription when it has had one before.
  it('offers checkout, not the portal, when there is no live subscription', () => {
    expect(subscriptionTabState(null, 'basic', NOW))
      .toMatchObject({ canSubscribe: true, canManage: false })
    expect(subscriptionTabState({ status: 'canceled', stripe_customer_id: 'cus_1' }, 'basic', NOW))
      .toMatchObject({ canSubscribe: true, canManage: false })
  })

  // The two are exact complements — offering both would mean a second subscription on a shop
  // that already pays.
  it('never offers checkout and the portal at the same time', () => {
    for (const status of ['trialing', 'active', 'past_due']) {
      const state = subscriptionTabState(
        { status, stripe_customer_id: 'cus_1', trial_ends_at: '2026-08-11T00:00:00Z' }, 'basic', NOW,
      )
      expect(state.canSubscribe).toBe(false)
      expect(state.canManage).toBe(true)
    }
  })

  // The pitch does NOT depend on having a subscription: a Pro lock's CTA promises the price and
  // the feature list, so a comped or pre-checkout basic shop must still get them — only the
  // button needs a Stripe customer to point at.
  it('still pitches Pro to a basic shop with no subscription', () => {
    expect(subscriptionTabState(null, 'basic', NOW))
      .toMatchObject({ kind: 'none', canUpgrade: true, canManage: false })
  })

  // A Pro shop cannot upgrade, but must still reach the portal — to change its card, read an
  // invoice, or step back down to Basic without cancelling the shop.
  it('lets a pro shop reach the portal even though it cannot upgrade', () => {
    expect(subscriptionTabState({ status: 'active', stripe_customer_id: 'cus_1' }, 'pro', NOW))
      .toMatchObject({ canUpgrade: false, canManage: true })
  })

  // A comped Pro shop has no subscription but IS entitled — the tab must say so rather than
  // implying they are unsubscribed and should pay.
  it('reports the entitled plan even with no subscription behind it', () => {
    expect(subscriptionTabState(null, 'pro', NOW)).toMatchObject({ kind: 'none', plan: 'pro' })
  })

  it('surfaces a trial with its end date', () => {
    const state = subscriptionTabState(
      { status: 'trialing', stripe_customer_id: 'cus_1', trial_ends_at: '2026-08-11T00:00:00Z' },
      'basic',
      NOW,
    )
    expect(state).toMatchObject({ kind: 'trial', daysLeft: 10, plan: 'basic', canUpgrade: true })
  })

  it('clamps a trial that has already lapsed to zero rather than going negative', () => {
    const state = subscriptionTabState(
      { status: 'trialing', stripe_customer_id: 'cus_1', trial_ends_at: '2026-07-30T00:00:00Z' },
      'basic',
      NOW,
    )
    expect(state).toMatchObject({ kind: 'trial', daysLeft: 0 })
  })

  // Past due is the one state where "change plan" is the wrong advice — the card is the problem.
  it('flags past-due and does not invite an upgrade', () => {
    const state = subscriptionTabState(
      { status: 'past_due', stripe_customer_id: 'cus_1' },
      'basic',
      NOW,
    )
    expect(state).toMatchObject({ kind: 'past-due', canUpgrade: false, canManage: true })
  })

  // A cancelled subscription still has a Stripe customer, but SuspendedScreen owns reactivation
  // via Checkout — so `canManage` must be false and this tab must not grow a second, competing
  // payment path. (`canUpgrade` may still be true; it only decides whether the price and feature
  // list are shown, and a cancelled shop is suspended and never reaches these tabs anyway.)
  it('offers nothing to act on when the subscription is cancelled', () => {
    expect(subscriptionTabState({ status: 'canceled', stripe_customer_id: 'cus_1' }, 'basic', NOW))
      .toMatchObject({ kind: 'none', canManage: false })
  })
})
