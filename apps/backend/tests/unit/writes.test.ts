import { describe, it, expect } from 'vitest'
import { pickMerchantConfig } from '../../src/writes.js'

describe('pickMerchantConfig — fulfilment', () => {
  it('accepts a config bag and a real timezone', () => {
    expect(pickMerchantConfig({
      config: { fulfilment: { lead_days: 1, window_days: 7, closed_weekdays: [1] } },
      timezone: 'Asia/Kuala_Lumpur',
    })).toEqual({
      ok: true,
      patch: {
        config: { fulfilment: { lead_days: 1, window_days: 7, closed_weekdays: [1] } },
        timezone: 'Asia/Kuala_Lumpur',
      },
    })
  })

  it('drops a timezone Intl cannot parse rather than writing it', () => {
    expect(pickMerchantConfig({ timezone: 'Mars/Olympus' })).toEqual({ ok: true, patch: {} })
  })

  it('still refuses the privilege columns', () => {
    expect(pickMerchantConfig({ status: 'active', owner_id: 'x', slug: 'y', plan: 'pro' })).toEqual({ ok: true, patch: {} })
  })
})

describe('pickMerchantConfig — tax (#88)', () => {
  it('accepts a valid enabled + rate pair', () => {
    expect(pickMerchantConfig({ tax_enabled: true, tax_rate: 6 })).toEqual({
      ok: true,
      patch: { tax_enabled: true, tax_rate: 6 },
    })
  })

  it('coerces a numeric-string rate (PATCH bodies can carry either)', () => {
    expect(pickMerchantConfig({ tax_rate: '6' })).toEqual({ ok: true, patch: { tax_rate: 6 } })
  })

  it('refuses a rate above 100 rather than clamping it', () => {
    expect(pickMerchantConfig({ tax_rate: 150 })).toEqual({ ok: false, error: expect.any(String) })
  })

  it('refuses a negative rate', () => {
    expect(pickMerchantConfig({ tax_rate: -1 })).toEqual({ ok: false, error: expect.any(String) })
  })

  it('refuses a non-numeric rate', () => {
    expect(pickMerchantConfig({ tax_rate: 'six' })).toEqual({ ok: false, error: expect.any(String) })
  })

  it('refuses a blank rate rather than coercing it to 0', () => {
    expect(pickMerchantConfig({ tax_rate: '' })).toEqual({ ok: false, error: expect.any(String) })
  })

  it('refuses a whitespace-only rate rather than coercing it to 0', () => {
    expect(pickMerchantConfig({ tax_rate: '   ' })).toEqual({ ok: false, error: expect.any(String) })
  })

  it('refuses a non-boolean tax_enabled', () => {
    expect(pickMerchantConfig({ tax_enabled: 'yes' })).toEqual({ ok: false, error: expect.any(String) })
  })

  it('refuses a rate the numeric(5,2) column would round on write', () => {
    expect(pickMerchantConfig({ tax_rate: 100.005 })).toEqual({ ok: false, error: expect.any(String) })
  })

  it('refuses a rate with more than 2 decimal places', () => {
    expect(pickMerchantConfig({ tax_rate: 6.567 })).toEqual({ ok: false, error: expect.any(String) })
  })

  it('accepts a rate with exactly 1 decimal place', () => {
    expect(pickMerchantConfig({ tax_rate: 6.5 })).toEqual({ ok: true, patch: { tax_rate: 6.5 } })
  })

  it('accepts a whole-number rate', () => {
    expect(pickMerchantConfig({ tax_rate: 6 })).toEqual({ ok: true, patch: { tax_rate: 6 } })
  })
})

describe('pickMerchantConfig — onboarding flags (#102)', () => {
  it('accepts the three onboarding booleans', () => {
    expect(pickMerchantConfig({
      onboarding_shipping_set: true,
      onboarding_link_shared: true,
      onboarding_dismissed: true,
    })).toEqual({
      ok: true,
      patch: {
        onboarding_shipping_set: true,
        onboarding_link_shared: true,
        onboarding_dismissed: true,
      },
    })
  })

  it('passes a field through untouched when absent', () => {
    expect(pickMerchantConfig({ onboarding_link_shared: true })).toEqual({
      ok: true,
      patch: { onboarding_link_shared: true },
    })
  })

  it('refuses a non-boolean onboarding flag rather than coercing it', () => {
    expect(pickMerchantConfig({ onboarding_shipping_set: 'yes' }))
      .toEqual({ ok: false, error: expect.any(String) })
    expect(pickMerchantConfig({ onboarding_dismissed: 1 }))
      .toEqual({ ok: false, error: expect.any(String) })
  })
})
