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
      .toEqual({ kind: 'trial', urgent: false, daysLeft: 3, hoursLeft: 1 })
  })

  it('turns urgent at exactly 72 hours', () => {
    expect(billingBannerState({ status: 'trialing', trial_ends_at: hoursFromNow(72) }, NOW))
      .toEqual({ kind: 'trial', urgent: true, daysLeft: 3, hoursLeft: 0 })
  })

  it('stays urgent through the final hours', () => {
    expect(billingBannerState({ status: 'trialing', trial_ends_at: hoursFromNow(2) }, NOW))
      .toEqual({ kind: 'trial', urgent: true, daysLeft: 0, hoursLeft: 2 })
  })

  it('clamps to zero after the trial end while the webhook lags', () => {
    expect(billingBannerState({ status: 'trialing', trial_ends_at: hoursFromNow(-1) }, NOW))
      .toEqual({ kind: 'trial', urgent: true, daysLeft: 0, hoursLeft: 0 })
  })

  it('flags past_due for the failed-renewal banner', () => {
    expect(billingBannerState({ status: 'past_due' }, NOW)).toEqual({ kind: 'past-due' })
  })
})
