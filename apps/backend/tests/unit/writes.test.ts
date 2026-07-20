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
})
