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
