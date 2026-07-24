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

  // The trial banner's bar drains as the trial runs out: fraction remaining = daysLeft / 7.
  it('reports trial progress as the fraction of the 7-day trial remaining', () => {
    const state = subscriptionTabState(
      { status: 'trialing', stripe_customer_id: 'cus_1', trial_ends_at: '2026-08-04T00:00:00Z' },
      'basic',
      NOW, // 2026-08-01 → 3 days left
    )
    expect(state).toMatchObject({ kind: 'trial', daysLeft: 3 })
    expect(state.kind === 'trial' && state.progress).toBeCloseTo(3 / 7)
  })

  it('drains trial progress to zero once the trial has lapsed', () => {
    const state = subscriptionTabState(
      { status: 'trialing', stripe_customer_id: 'cus_1', trial_ends_at: '2026-07-30T00:00:00Z' },
      'basic',
      NOW,
    )
    expect(state.kind === 'trial' && state.progress).toBe(0)
  })

  // The natural full bar: a fresh 7-day trial fills it exactly, without leaning on the clamp.
  it('fills the trial bar for a fresh 7-day trial', () => {
    const state = subscriptionTabState(
      { status: 'trialing', stripe_customer_id: 'cus_1', trial_ends_at: '2026-08-08T00:00:00Z' },
      'basic',
      NOW, // 2026-08-01 → exactly 7 days left
    )
    expect(state).toMatchObject({ kind: 'trial', daysLeft: 7 })
    expect(state.kind === 'trial' && state.progress).toBe(1)
  })

  // A trial longer than 7 days (Stripe could be told otherwise) must not overflow the bar.
  it('clamps trial progress to a full bar when more than 7 days remain', () => {
    const state = subscriptionTabState(
      { status: 'trialing', stripe_customer_id: 'cus_1', trial_ends_at: '2026-08-11T00:00:00Z' },
      'basic',
      NOW, // 10 days left
    )
    expect(state.kind === 'trial' && state.progress).toBe(1)
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

// ── Winding down ───────────────────────────────────────────────────────────────
// The bug this half of the module exists for: Stripe leaves `status` on 'active' for a
// subscription cancelling at period end, so the tab promised "Renews on 1 Sep" right up to the
// morning the shop was suspended. Nothing about the status can be trusted to reveal it.
describe('subscriptionTabState — pending cancellation', () => {
  const ending = {
    status: 'active',
    stripe_customer_id: 'cus_1',
    current_period_end: '2026-09-01T00:00:00Z',
    cancel_at_period_end: true,
  }

  it('reports a subscription that is ending, not one that renews', () => {
    expect(subscriptionTabState(ending, 'pro', NOW))
      .toMatchObject({ kind: 'ending', endsAt: '2026-09-01T00:00:00Z' })
  })

  // Two cancel buttons for one subscription is how a merchant ends up unsure whether the first
  // click worked. Once it is cancelling, the only forward action is undoing it.
  it('offers resume instead of cancel once it is already cancelling', () => {
    expect(subscriptionTabState(ending, 'pro', NOW))
      .toMatchObject({ canResume: true, canCancel: false })
  })

  // Selling Pro to someone on their way out, and scheduling a tier for a period that will never
  // be billed, are both nonsense — and the backend refuses the second with `subscription_ending`.
  it('offers neither an upgrade nor a downgrade while it is ending', () => {
    expect(subscriptionTabState(ending, 'basic', NOW)).toMatchObject({ canUpgrade: false })
    expect(subscriptionTabState(ending, 'pro', NOW)).toMatchObject({ canDowngrade: false })
  })

  // Cancelling suspends the shop, so the merchant must still reach the portal for the invoices
  // and receipts of the period they did pay for.
  it('still allows the portal while it is ending', () => {
    expect(subscriptionTabState(ending, 'pro', NOW)).toMatchObject({ canManage: true })
  })

  // The shop has NOT closed yet, so it must not be sold a second subscription alongside the one
  // still running — that is the double-billing `canSubscribe` exists to prevent.
  it('does not offer checkout while the current subscription still runs', () => {
    expect(subscriptionTabState(ending, 'pro', NOW)).toMatchObject({ canSubscribe: false })
  })

  // A trial that is cancelling ends the same way — suspended — and saying "3 days left" without
  // saying "then it stops" is the same silence in a friendlier voice.
  it('reports a cancelling trial as ending', () => {
    const state = subscriptionTabState(
      { ...ending, status: 'trialing', trial_ends_at: '2026-08-11T00:00:00Z' }, 'basic', NOW,
    )
    expect(state.kind).toBe('ending')
  })
})

describe('subscriptionTabState — pending downgrade', () => {
  const downgrading = {
    status: 'active',
    stripe_customer_id: 'cus_1',
    current_period_end: '2026-09-01T00:00:00Z',
    pending_plan: 'basic',
  }

  // LOAD-BEARING. The shop paid for Pro through this period and keeps it — `pending_plan` is
  // intent, never entitlement. A tab that already showed Basic would have the merchant believe
  // they had lost features they can still use.
  it('still reports the shop as pro until the change lands', () => {
    expect(subscriptionTabState(downgrading, 'pro', NOW))
      .toMatchObject({ plan: 'pro', pendingPlan: 'basic', pendingAt: '2026-09-01T00:00:00Z' })
  })

  it('offers resume rather than a second downgrade', () => {
    expect(subscriptionTabState(downgrading, 'pro', NOW))
      .toMatchObject({ canResume: true, canDowngrade: false })
  })

  // Cancelling outright is strictly more than downgrading, and the backend releases the schedule
  // to do it — so the option must stay open.
  it('still allows cancelling outright', () => {
    expect(subscriptionTabState(downgrading, 'pro', NOW)).toMatchObject({ canCancel: true })
  })

  // Not the same state as a cancellation: the shop stays open and keeps being billed, just at
  // the lower tier. Conflating them would tell a downgrading merchant their shop is closing.
  it('is not reported as ending', () => {
    expect(subscriptionTabState(downgrading, 'pro', NOW).kind).toBe('live')
  })
})

describe('subscriptionTabState — the ordinary case', () => {
  const live = { status: 'active', stripe_customer_id: 'cus_1', current_period_end: '2026-09-01T00:00:00Z' }

  it('offers a pro shop the downgrade and the cancel, and nothing to resume', () => {
    expect(subscriptionTabState(live, 'pro', NOW))
      .toMatchObject({ canDowngrade: true, canCancel: true, canResume: false, pendingPlan: null })
  })

  // There is nothing below Basic but leaving, so the step-down must not be offered to a shop
  // that is already on the floor.
  it('offers a basic shop the cancel but not the downgrade', () => {
    expect(subscriptionTabState(live, 'basic', NOW))
      .toMatchObject({ canDowngrade: false, canCancel: true })
  })

  // Every one of these calls Stripe against a subscription id. Without one there is nothing to
  // act on, and the routes answer 409 `no_live_subscription`.
  it('offers none of them without a live subscription', () => {
    expect(subscriptionTabState(null, 'pro', NOW))
      .toMatchObject({ canDowngrade: false, canCancel: false, canResume: false })
  })

  // A past-due subscription is still a real subscription — a merchant whose card is failing must
  // be able to stop it rather than watch it retry.
  it('lets a past-due shop cancel', () => {
    expect(subscriptionTabState({ status: 'past_due', stripe_customer_id: 'cus_1' }, 'pro', NOW))
      .toMatchObject({ canCancel: true })
  })
})
