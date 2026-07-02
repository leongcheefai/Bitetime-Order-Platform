import { describe, it, expect } from 'vitest'
import { canStartTrial, buildTrialReminderEmail } from '../../src/billingLifecycle.js'

describe('canStartTrial', () => {
  it('allows a merchant with no billing row (never touched Stripe)', () => {
    expect(canStartTrial(null)).toBe(true)
    expect(canStartTrial(undefined)).toBe(true)
  })

  it('allows a merchant with a customer but no subscription (created, never subscribed)', () => {
    expect(canStartTrial({ stripe_customer_id: 'cus_1', stripe_subscription_id: null })).toBe(true)
  })

  it('refuses a merchant that has ever had a subscription — one trial ever', () => {
    expect(canStartTrial({ stripe_subscription_id: 'sub_1', status: 'canceled' })).toBe(false)
    expect(canStartTrial({ stripe_subscription_id: 'sub_1', status: 'trialing' })).toBe(false)
  })
})

describe('buildTrialReminderEmail', () => {
  const input = {
    shopName: 'Sunny Bakes',
    trialEndsAt: '2026-07-09T08:00:00.000Z',
    dashboardUrl: 'http://localhost:5173/merchant',
  }

  it('names the shop, links the dashboard, and states the deadline', () => {
    const { subject, text } = buildTrialReminderEmail(input)
    expect(subject).toContain('Sunny Bakes')
    expect(subject).toContain('3 days')
    expect(text).toContain('Sunny Bakes')
    expect(text).toContain('http://localhost:5173/merchant')
    expect(text).toContain('Jul 9, 2026')
  })

  it('warns that the shop is suspended if unpaid', () => {
    const { text } = buildTrialReminderEmail(input)
    expect(text.toLowerCase()).toContain('suspended')
  })
})
