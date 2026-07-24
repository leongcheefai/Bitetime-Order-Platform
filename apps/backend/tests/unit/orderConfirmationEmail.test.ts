import { describe, it, expect } from 'vitest'
import { buildOrderConfirmationEmail } from '../../src/notify.js'

// A delivery order the storefront would send, shaped like a real `orders` row.
const DELIVERY_ORDER = {
  order_number: 'BT-260629-0051',
  customer_name: 'Sam',
  mode: 'delivery',
  fulfil_date: '2026-06-30',
  address: { line1: '12 Jalan Test', postcode: '43000', city: 'Kajang', state: 'Selangor' },
  delivery_distance_km: 4.2,
  items: [
    { name: 'Cookie', qty: 2, price: 5 },
    { name: 'Cake', qty: 1, price: 20, promo: true },
  ],
  shipping_fee: 8,
  total: 38,
  currency: 'MYR',
}

const PICKUP_ORDER = {
  order_number: 'BT-260629-0052',
  customer_name: 'Mei',
  mode: 'pickup',
  fulfil_date: '2026-06-30',
  address: null,
  items: [{ name: 'Bun', qty: 3, price: 2 }],
  shipping_fee: 0,
  total: 6,
  currency: 'MYR',
}

const build = (order: any, lang: 'en' | 'zh') =>
  buildOrderConfirmationEmail(order, 'Cookie Corner', 'cookie-corner', 'https://tinyorder.app', lang)

describe('buildOrderConfirmationEmail', () => {
  it('renders an English receipt: shop, order number, name line, items, shipping, total, link', () => {
    const { subject, text, html } = build(DELIVERY_ORDER, 'en')
    expect(subject).toBe('Cookie Corner — Order BT-260629-0051 confirmed')
    for (const part of [text, html]) {
      expect(part).toContain('Cookie Corner')
      expect(part).toContain('BT-260629-0051')
      expect(part).toContain('Sam') // Order for {name}
      expect(part).toContain('Cookie')
      expect(part).toContain('Cake')
      expect(part).toContain('RM 8.00') // shipping
      expect(part).toContain('RM 38.00') // total
      expect(part).toContain('https://tinyorder.app/s/cookie-corner')
    }
  })

  it('renders a Chinese receipt when lang is zh', () => {
    const { subject, text, html } = build(DELIVERY_ORDER, 'zh')
    expect(subject).toBe('Cookie Corner — 订单 BT-260629-0051 已确认')
    expect(text).toContain('感谢您的订单') // ZH body copy present
    expect(html).toContain('订单人') // ZH "Order for" label
    expect(text).toContain('送货') // ZH mode label
    // English mode label must not leak into the ZH receipt.
    expect(text).not.toContain('Express delivery')
  })

  it('shows quantity and line price for each item', () => {
    const { text } = build(DELIVERY_ORDER, 'en')
    expect(text).toContain('Cookie') // 2 × RM5 = RM10
    expect(text).toContain('RM 10.00')
    expect(text).toContain('RM 20.00') // Cake line
  })

  it('marks a promo-flagged item and leaves a plain item unmarked', () => {
    const { text, html } = build(DELIVERY_ORDER, 'en')
    // The Cake line is promo; the Cookie line is not.
    expect(text).toContain('(Promo)')
    expect(html).toContain('(Promo)')
    const promoCount = (text.match(/\(Promo\)/g) || []).length
    expect(promoCount).toBe(1)
  })

  it('includes the delivery address for a delivery order', () => {
    const { text, html } = build(DELIVERY_ORDER, 'en')
    expect(text).toContain('12 Jalan Test')
    expect(html).toContain('12 Jalan Test')
  })

  it('omits the address for a pickup order', () => {
    const { text, html } = build(PICKUP_ORDER, 'en')
    expect(text).not.toContain('Jalan')
    expect(html).not.toContain('Jalan')
  })

  it('never leaks the internal distance figure', () => {
    const { text, html } = build(DELIVERY_ORDER, 'en')
    expect(text).not.toContain('4.2')
    expect(html).not.toContain('4.2')
    expect(text.toLowerCase()).not.toContain('km')
  })

  it('shows the fulfilment date and a mode label', () => {
    const { text } = build(DELIVERY_ORDER, 'en')
    expect(text).toContain('2026-06-30')
    expect(text).toContain('Delivery')
  })

  it('formats money in the order\'s stamped currency, defaulting to MYR for legacy null', () => {
    const sgd = build({ ...PICKUP_ORDER, currency: 'SGD', total: 6 }, 'en')
    expect(sgd.text).toContain('S$ 6.00')
    const legacy = build({ ...PICKUP_ORDER, currency: null }, 'en')
    expect(legacy.text).toContain('RM 6.00')
  })
})
