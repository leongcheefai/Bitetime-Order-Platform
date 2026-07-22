import { describe, it, expect } from 'vitest'
import { formatAddress } from './address'

describe('formatAddress', () => {
  it('joins a structured address, skipping empty parts', () => {
    expect(
      formatAddress({ line1: '12 Jalan Ceria', postcode: '43000', city: 'Kajang', state: 'Selangor' }),
    ).toBe('12 Jalan Ceria, 43000 Kajang, Selangor')
  })

  it('omits missing pieces without stray separators', () => {
    expect(formatAddress({ line1: '12 Jalan Ceria', postcode: '', city: '', state: 'Selangor' }))
      .toBe('12 Jalan Ceria, Selangor')
  })

  it('returns a legacy string address unchanged', () => {
    expect(formatAddress('12 Jalan Ceria, Kajang')).toBe('12 Jalan Ceria, Kajang')
  })

  it('returns empty string for nullish input', () => {
    expect(formatAddress(null)).toBe('')
    expect(formatAddress(undefined)).toBe('')
  })

  it('puts the unit in front of the street line', () => {
    expect(formatAddress({ line1: '12 Jalan Test', unit: 'A-3-2', postcode: '50000', city: 'KL', state: 'Selangor' }))
      .toBe('A-3-2, 12 Jalan Test, 50000 KL, Selangor')
  })
})
