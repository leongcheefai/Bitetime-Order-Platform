import { describe, it, expect } from 'vitest'
import { estimateFor, COUNTRY_TO_CURRENCY, MYR_RATES } from '../../src/fx.js'

describe('estimateFor', () => {
  it('returns null for Malaysia (RM is already their currency)', () => {
    expect(estimateFor('MY')).toBeNull()
  })

  it('maps a listed country to its currency and MYR rate', () => {
    expect(estimateFor('SG')).toEqual({ currency: 'SGD', rate: MYR_RATES.SGD })
  })

  it('falls back to a USD estimate for an unlisted country', () => {
    expect(estimateFor('GB')).toEqual({ currency: 'USD', rate: MYR_RATES.USD })
  })

  it('falls back to USD for an empty/undetected country', () => {
    expect(estimateFor('')).toEqual({ currency: 'USD', rate: MYR_RATES.USD })
  })

  it('is case-insensitive and trims', () => {
    expect(estimateFor(' sg ')).toEqual({ currency: 'SGD', rate: MYR_RATES.SGD })
    expect(estimateFor(' my ')).toBeNull()
  })

  it('has a MYR rate for every mapped currency', () => {
    for (const currency of Object.values(COUNTRY_TO_CURRENCY)) {
      expect(typeof MYR_RATES[currency]).toBe('number')
    }
  })
})
