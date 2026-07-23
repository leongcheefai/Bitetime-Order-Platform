import { describe, it, expect } from 'vitest'
import { buildOrderMessage, formatAddress } from '../../src/notify.js'

describe('backend formatAddress', () => {
  it('joins a structured address', () => {
    expect(formatAddress({ line1: '12 Jalan Ceria', postcode: '43000', city: 'Kajang', state: 'Selangor' }))
      .toBe('12 Jalan Ceria, 43000 Kajang, Selangor')
  })

  it('passes a legacy string through', () => {
    expect(formatAddress('12 Jalan Ceria, Kajang')).toBe('12 Jalan Ceria, Kajang')
  })

  it('returns empty string for nullish', () => {
    expect(formatAddress(null)).toBe('')
    expect(formatAddress(undefined)).toBe('')
  })

  it('renders a real Google-shaped distance address once, not twice, when a place_id is present', () => {
    // `line1` here is exactly what the storefront stores for a distance order: Google's OWN full
    // formatted address, which already contains the postcode/city/state — the real shape a short
    // fixed stub could never catch (#101 review, Finding 3).
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
})

describe('buildOrderMessage', () => {
  it('formats a structured delivery address in the Telegram body', () => {
    const msg = buildOrderMessage({
      order_number: 'AB-20260705-0001',
      customer_name: 'Amir',
      mode: 'delivery',
      address: { line1: '12 Jalan Ceria', postcode: '43000', city: 'Kajang', state: 'Selangor' },
      items: [{ name: 'Nasi Lemak', qty: 2, price: 5 }],
      total: 18,
      currency: 'MYR',
    })
    expect(msg).toContain('*Address:* 12 Jalan Ceria, 43000 Kajang, Selangor')
  })
})
