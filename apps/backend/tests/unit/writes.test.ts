import { describe, it, expect } from 'vitest'
import { pickMerchantConfig } from '../../src/writes.js'

describe('pickMerchantConfig — fulfilment', () => {
  it('accepts a config bag and a real timezone', () => {
    expect(pickMerchantConfig({
      config: { fulfilment: { lead_days: 1, window_days: 7, closed_weekdays: [1] } },
      timezone: 'Asia/Kuala_Lumpur',
    })).toEqual({
      config: { fulfilment: { lead_days: 1, window_days: 7, closed_weekdays: [1] } },
      timezone: 'Asia/Kuala_Lumpur',
    })
  })

  it('drops a timezone Intl cannot parse rather than writing it', () => {
    expect(pickMerchantConfig({ timezone: 'Mars/Olympus' })).toEqual({})
  })

  it('still refuses the privilege columns', () => {
    expect(pickMerchantConfig({ status: 'active', owner_id: 'x', slug: 'y', plan: 'pro' })).toEqual({})
  })
})
