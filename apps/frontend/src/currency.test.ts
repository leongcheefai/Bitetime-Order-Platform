import { describe, it, expect } from 'vitest'
import { formatMoney, currencyDef, CURRENCY_CODES, DEFAULT_CURRENCY } from './currency'

describe('formatMoney', () => {
  it('renders MYR exactly as today: symbol before, space, 2 decimals', () => {
    expect(formatMoney(8, 'MYR')).toBe('RM 8.00')
    expect(formatMoney(18, 'MYR')).toBe('RM 18.00')
    expect(formatMoney(0, 'MYR')).toBe('RM 0.00')
  })

  it('omits cents for 0-decimal currencies (IDR, VND, JPY)', () => {
    expect(formatMoney(10000, 'IDR')).toBe('Rp 10,000')
    expect(formatMoney(25000, 'VND')).toBe('₫ 25,000')
    expect(formatMoney(500, 'JPY')).toBe('¥ 500')
  })

  it('adds a thousands separator on large amounts', () => {
    expect(formatMoney(1234.5, 'MYR')).toBe('RM 1,234.50')
    expect(formatMoney(1000000, 'IDR')).toBe('Rp 1,000,000')
    expect(formatMoney(1234.56, 'SGD')).toBe('S$ 1,234.56')
  })

  it('rounds to the currency decimals', () => {
    expect(formatMoney(8.005, 'MYR')).toBe('RM 8.01')
    expect(formatMoney(999.6, 'JPY')).toBe('¥ 1,000')
  })

  it('falls back to the default currency (MYR) for an unknown or missing code', () => {
    expect(formatMoney(8, 'XXX')).toBe('RM 8.00')
    expect(formatMoney(8, undefined)).toBe('RM 8.00')
    expect(formatMoney(8, null)).toBe('RM 8.00')
  })

  it('coerces non-finite amounts to 0', () => {
    expect(formatMoney(NaN, 'MYR')).toBe('RM 0.00')
    expect(formatMoney(undefined as any, 'USD')).toBe('$ 0.00')
  })

  it('formats every seeded currency without throwing', () => {
    for (const code of CURRENCY_CODES) {
      expect(() => formatMoney(1234.5, code)).not.toThrow()
      expect(formatMoney(1234.5, code)).toContain(currencyDef(code).symbol)
    }
  })
})

describe('currencyDef', () => {
  it('returns the default for unknown / missing codes', () => {
    expect(currencyDef('XXX').code).toBe(DEFAULT_CURRENCY)
    expect(currencyDef(null).code).toBe(DEFAULT_CURRENCY)
    expect(currencyDef(undefined).code).toBe(DEFAULT_CURRENCY)
  })

  it('MYR is the default and seeded', () => {
    expect(DEFAULT_CURRENCY).toBe('MYR')
    expect(CURRENCY_CODES).toContain('MYR')
    expect(currencyDef('MYR')).toMatchObject({ code: 'MYR', symbol: 'RM', decimals: 2 })
  })
})
