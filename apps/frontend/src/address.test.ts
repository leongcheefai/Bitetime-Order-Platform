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

  it('renders a real Google-shaped distance address once, not twice, when a place_id is present', () => {
    // `line1` here is exactly what `pickDestination` stores: Google's OWN full formatted address,
    // which already contains the postcode/city/state — this is the real shape that a short fixed
    // stub could never catch (#101 review, Finding 3).
    expect(
      formatAddress({
        line1: '12 Jalan SS 2/24, 47300 Petaling Jaya, Selangor, Malaysia',
        unit: 'A-3-2',
        postcode: '47300',
        city: 'Petaling Jaya',
        state: 'Selangor',
        place_id: 'ChIJ_test_place_id',
      }),
    ).toBe('A-3-2, 12 Jalan SS 2/24, 47300 Petaling Jaya, Selangor, Malaysia')
  })

  it('still appends the postcode/city/state tail for a region address (no place_id)', () => {
    expect(
      formatAddress({ line1: '12 Jalan Ceria', postcode: '43000', city: 'Kajang', state: 'Selangor' }),
    ).toBe('12 Jalan Ceria, 43000 Kajang, Selangor')
  })
})
