import { describe, it, expect } from 'vitest'
import { billingBannerState } from './billingBannerState'

const NOW = new Date('2026-07-02T12:00:00.000Z')
const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString()

describe('billingBannerState', () => {
  it('is none with no billing row', () => {
    expect(billingBannerState(null, NOW)).toEqual({ kind: 'none' })
    expect(billingBannerState(undefined, NOW)).toEqual({ kind: 'none' })
  })

  it('is none for an active (paid) subscription', () => {
    expect(billingBannerState({ status: 'active' }, NOW)).toEqual({ kind: 'none' })
  })

  it('is none when trialing without a recorded trial end', () => {
    expect(billingBannerState({ status: 'trialing', trial_ends_at: null }, NOW)).toEqual({ kind: 'none' })
  })

  it('counts down a comfortable trial without urgency', () => {
    expect(billingBannerState({ status: 'trialing', trial_ends_at: hoursFromNow(73) }, NOW))
      .toEqual({ kind: 'trial', urgent: false, hasPaymentMethod: false, daysLeft: 3, hoursLeft: 1 })
  })

  it('turns urgent at exactly 72 hours', () => {
    expect(billingBannerState({ status: 'trialing', trial_ends_at: hoursFromNow(72) }, NOW))
      .toEqual({ kind: 'trial', urgent: true, hasPaymentMethod: false, daysLeft: 3, hoursLeft: 0 })
  })

  it('stays urgent through the final hours', () => {
    expect(billingBannerState({ status: 'trialing', trial_ends_at: hoursFromNow(2) }, NOW))
      .toEqual({ kind: 'trial', urgent: true, hasPaymentMethod: false, daysLeft: 0, hoursLeft: 2 })
  })

  it('clamps to zero after the trial end while the webhook lags', () => {
    expect(billingBannerState({ status: 'trialing', trial_ends_at: hoursFromNow(-1) }, NOW))
      .toEqual({ kind: 'trial', urgent: true, hasPaymentMethod: false, daysLeft: 0, hoursLeft: 0 })
  })

  it('never goes urgent once a card is on file, even inside the 72h window', () => {
    expect(billingBannerState({ status: 'trialing', trial_ends_at: hoursFromNow(2), has_payment_method: true }, NOW))
      .toEqual({ kind: 'trial', urgent: false, hasPaymentMethod: true, daysLeft: 0, hoursLeft: 2 })
  })

  it('keeps counting down with a card outside the urgent window', () => {
    expect(billingBannerState({ status: 'trialing', trial_ends_at: hoursFromNow(73), has_payment_method: true }, NOW))
      .toEqual({ kind: 'trial', urgent: false, hasPaymentMethod: true, daysLeft: 3, hoursLeft: 1 })
  })

  it('flags past_due for the failed-renewal banner', () => {
    expect(billingBannerState({ status: 'past_due' }, NOW)).toEqual({ kind: 'past-due' })
  })
})

// A cancelled subscription reports `status: 'trialing'` or `'active'` right up to the day it
// lapses, so without the flag the banner counted down a trial and told a merchant who had just
// cancelled to ADD A PAYMENT METHOD — asking for a card to keep something they chose to end.
describe('billingBannerState — winding down', () => {
  const ending = {
    status: 'active',
    cancel_at_period_end: true,
    current_period_end: '2026-08-01T00:00:00.000Z',
  }

  it('reports an ending subscription with the date the shop is suspended', () => {
    expect(billingBannerState(ending, NOW))
      .toEqual({ kind: 'ending', endsAt: '2026-08-01T00:00:00.000Z' })
  })

  // Outranks the trial branch: a cancelling trial ends in a suspended shop, and counting down
  // the free days without saying that is the more misleading of the two messages.
  it('outranks a running trial', () => {
    expect(billingBannerState({ ...ending, status: 'trialing', trial_ends_at: hoursFromNow(48) }, NOW).kind)
      .toBe('ending')
  })

  // And past-due: the card stops mattering once the subscription is ending anyway.
  it('outranks past-due', () => {
    expect(billingBannerState({ ...ending, status: 'past_due' }, NOW).kind).toBe('ending')
  })

  it('still reports no date when the period end is missing', () => {
    expect(billingBannerState({ status: 'active', cancel_at_period_end: true }, NOW))
      .toEqual({ kind: 'ending', endsAt: null })
  })

  // The flag is false for the overwhelming majority of rows; it must not disturb them.
  it('leaves an ordinary trial alone', () => {
    expect(billingBannerState({ status: 'trialing', trial_ends_at: hoursFromNow(48), cancel_at_period_end: false }, NOW).kind)
      .toBe('trial')
  })
})
