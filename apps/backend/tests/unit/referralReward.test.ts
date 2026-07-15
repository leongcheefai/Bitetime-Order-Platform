import { describe, it, expect } from 'vitest'
import {
  monthlyCreditAmount,
  subInfoFromStripe,
  decideReferralReward,
  type ReferrerCandidate,
  type ReferralRewardInput,
} from '../../src/referralReward.js'

// A referrer on an active, paying plan — the happy-path candidate.
const activeReferrer = (over: Partial<ReferrerCandidate> = {}): ReferrerCandidate => ({
  merchantId: 'ref-merchant',
  ownerId: '11111111-1111-1111-1111-111111111111',
  billingStatus: 'active',
  stripeCustomerId: 'cus_referrer',
  subscription: { amount: 2900, interval: 'month', currency: 'usd' },
  paymentFingerprints: ['fp_referrer'],
  ...over,
})

const input = (over: Partial<ReferralRewardInput> = {}): ReferralRewardInput => ({
  referredByCode: 'ABCD1234',
  alreadyRewarded: false,
  candidates: [activeReferrer()],
  referred: { stripeCustomerId: 'cus_referred', paymentFingerprints: ['fp_referred'] },
  ...over,
})

describe('monthlyCreditAmount', () => {
  it('monthly plan: the amount as-is', () => {
    expect(monthlyCreditAmount({ amount: 2900, interval: 'month', currency: 'usd' })).toBe(2900)
  })

  it('yearly plan: annual amount ÷ 12, rounded to whole cents', () => {
    // 30000 / 12 = 2500
    expect(monthlyCreditAmount({ amount: 30000, interval: 'year', currency: 'usd' })).toBe(2500)
    // 29900 / 12 = 2491.66… → 2492
    expect(monthlyCreditAmount({ amount: 29900, interval: 'year', currency: 'usd' })).toBe(2492)
  })
})

describe('subInfoFromStripe', () => {
  const sub = (unit_amount: number | null, interval: string, currency = 'usd') =>
    ({ currency, items: { data: [{ price: { unit_amount, recurring: { interval } } }] } }) as any

  it('reads amount, interval and currency from the first item price', () => {
    expect(subInfoFromStripe(sub(2900, 'month', 'myr'))).toEqual({ amount: 2900, interval: 'month', currency: 'myr' })
    expect(subInfoFromStripe(sub(30000, 'year'))).toEqual({ amount: 30000, interval: 'year', currency: 'usd' })
  })

  it('returns null when the amount or interval is missing/unsupported', () => {
    expect(subInfoFromStripe(sub(null, 'month'))).toBeNull()
    expect(subInfoFromStripe(sub(2900, 'week'))).toBeNull()
    expect(subInfoFromStripe({ currency: 'usd', items: { data: [] } } as any)).toBeNull()
  })
})

describe('decideReferralReward', () => {
  it('grants when a single active referrer is resolved cleanly', () => {
    const d = decideReferralReward(input())
    expect(d).toEqual({
      grant: true,
      referrerMerchantId: 'ref-merchant',
      stripeCustomerId: 'cus_referrer',
      amount: 2900,
      currency: 'usd',
    })
  })

  it('values a yearly referrer at annual ÷ 12', () => {
    const d = decideReferralReward(
      input({ candidates: [activeReferrer({ subscription: { amount: 30000, interval: 'year', currency: 'usd' } })] }),
    )
    expect(d).toMatchObject({ grant: true, amount: 2500 })
  })

  it('skips when the referred shop signed up under no code', () => {
    expect(decideReferralReward(input({ referredByCode: null }))).toEqual({ grant: false, reason: 'not_referred' })
  })

  it('skips when a reward was already granted for this referred shop (idempotency)', () => {
    expect(decideReferralReward(input({ alreadyRewarded: true }))).toEqual({ grant: false, reason: 'already_rewarded' })
  })

  it('skips (forfeit) when the referrer has no active paid plan', () => {
    const trialing = activeReferrer({ billingStatus: 'trialing' })
    expect(decideReferralReward(input({ candidates: [trialing] }))).toEqual({
      grant: false,
      reason: 'referrer_no_paid_plan',
    })
    const noSub = activeReferrer({ subscription: null })
    expect(decideReferralReward(input({ candidates: [noSub] }))).toEqual({
      grant: false,
      reason: 'referrer_no_paid_plan',
    })
  })

  it('skips when no candidate matches the code at all', () => {
    expect(decideReferralReward(input({ candidates: [] }))).toEqual({ grant: false, reason: 'referrer_no_paid_plan' })
  })

  it('skips (never guesses) when two distinct owners collide on the 8-hex code', () => {
    const a = activeReferrer({ merchantId: 'm-a', ownerId: 'aaaa', stripeCustomerId: 'cus_a' })
    const b = activeReferrer({ merchantId: 'm-b', ownerId: 'bbbb', stripeCustomerId: 'cus_b' })
    expect(decideReferralReward(input({ candidates: [a, b] }))).toEqual({ grant: false, reason: 'ambiguous_referrer' })
  })

  it('skips self-referral when referred and referrer share a Stripe customer', () => {
    const d = decideReferralReward(
      input({
        candidates: [activeReferrer({ stripeCustomerId: 'cus_same' })],
        referred: { stripeCustomerId: 'cus_same', paymentFingerprints: [] },
      }),
    )
    expect(d).toEqual({ grant: false, reason: 'self_referral' })
  })

  it('skips self-referral when referred and referrer share a card fingerprint', () => {
    const d = decideReferralReward(
      input({
        candidates: [activeReferrer({ paymentFingerprints: ['fp_shared'] })],
        referred: { stripeCustomerId: 'cus_referred', paymentFingerprints: ['fp_shared'] },
      }),
    )
    expect(d).toEqual({ grant: false, reason: 'self_referral' })
  })

  it('resolves the single active referrer even if an inactive namesake also matches the code', () => {
    const inactive = activeReferrer({ merchantId: 'm-old', billingStatus: 'canceled', stripeCustomerId: 'cus_old' })
    const active = activeReferrer({ merchantId: 'm-live' })
    const d = decideReferralReward(input({ candidates: [inactive, active] }))
    expect(d).toMatchObject({ grant: true, referrerMerchantId: 'm-live' })
  })
})
