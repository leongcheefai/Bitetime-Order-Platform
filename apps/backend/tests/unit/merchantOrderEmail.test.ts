import { describe, it, expect } from 'vitest'
import { MAX_CART_LINES } from '@bitetime/shared'
import { buildMerchantOrderEmail } from '../../src/orderEmails.js'

// The shop's own surface, not the customer's. Twin of orderConfirmationEmail.test.ts, and the
// differences between the two are the point of this file: English only, and it carries the
// operational fields the customer's receipt deliberately omits (WhatsApp, routed distance).

const DELIVERY_ORDER = {
  order_number: 'BT-260629-0051',
  customer_name: 'Sam',
  customer_wa: '60123456789',
  mode: 'express',
  fulfil_date: '2026-06-30',
  address: { line1: '12 Jalan Test', postcode: '43000', city: 'Kajang', state: 'Selangor' },
  delivery_distance_km: 4.25,
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

const build = (order: any) => buildMerchantOrderEmail(order, 'Cookie Corner', 'https://tinyorder.app/merchant')

describe('buildMerchantOrderEmail', () => {
  it('names the order and its total in the subject, so an inbox can be triaged unopened', () => {
    expect(build(DELIVERY_ORDER).subject).toBe('New order BT-260629-0051 — RM 38.00')
  })

  it('renders the shop-facing order: shop, number, customer, items, shipping, total, dashboard link', () => {
    const { text, html } = build(DELIVERY_ORDER)
    for (const part of [text, html]) {
      expect(part).toContain('Cookie Corner')
      expect(part).toContain('BT-260629-0051')
      expect(part).toContain('Sam')
      expect(part).toContain('Cookie')
      expect(part).toContain('Cake')
      expect(part).toContain('RM 8.00') // shipping
      expect(part).toContain('RM 38.00') // total
      expect(part).toContain('https://tinyorder.app/merchant')
    }
  })

  it('carries the operational fields the customer receipt omits: WhatsApp and routed distance', () => {
    const { text, html } = build(DELIVERY_ORDER)
    for (const part of [text, html]) {
      expect(part).toContain('60123456789')
      // One decimal, matching the km the fee was computed from.
      expect(part).toContain('4.3 km')
    }
  })

  it('renders the fulfilment method by its own name and the delivery address', () => {
    const { text, html } = build(DELIVERY_ORDER)
    for (const part of [text, html]) {
      expect(part).toContain('Express delivery')
      expect(part).toContain('12 Jalan Test')
      expect(part).toContain('Kajang')
    }
  })

  it('marks a promo line, so the merchant sees which units sold at the reduced price', () => {
    const { text, html } = build(DELIVERY_ORDER)
    for (const part of [text, html]) expect(part).toContain('(Promo)')
  })

  it('is English only — the customer ordering in Chinese does not change the shop surface', () => {
    const { subject, text, html } = build(DELIVERY_ORDER)
    // The merchant surface has no translator. If any Chinese ever appears here, the shop's
    // language has been inferred from the customer's, which is the bug this pins shut.
    for (const part of [subject, text, html]) expect(part).not.toMatch(/[一-鿿]/)
  })

  it('omits address, distance and shipping on a pickup order rather than blanking them', () => {
    const { text, html } = build(PICKUP_ORDER)
    for (const part of [text, html]) {
      expect(part).toContain('Pickup')
      expect(part).not.toContain('Address')
      expect(part).not.toContain('Distance')
      expect(part).not.toContain('Shipping')
      expect(part).toContain('RM 6.00')
    }
  })

  it('omits fields absent on older rows instead of printing an empty label', () => {
    // fulfil_date is null for every order placed before #91; customer_wa can be blank.
    const { text, html } = build({ ...PICKUP_ORDER, fulfil_date: null, customer_wa: '' })
    for (const part of [text, html]) {
      expect(part).not.toContain('Date')
      expect(part).not.toContain('WhatsApp')
    }
  })

  it('prices in the currency stamped on the order, falling back to MYR for legacy rows', () => {
    expect(build({ ...PICKUP_ORDER, currency: 'SGD' }).text).toContain('S$ 6.00')
    expect(build({ ...PICKUP_ORDER, currency: null }).text).toContain('RM 6.00')
  })

  it('escapes an item name that would otherwise break the HTML', () => {
    const { html } = build({ ...PICKUP_ORDER, items: [{ name: '<script>x</script>', qty: 1, price: 2 }] })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('survives an order row with no items, rather than throwing on the alert', () => {
    expect(() => build({ ...PICKUP_ORDER, items: null })).not.toThrow()
  })

  // The mail arms have no length guard, and unlike Telegram's 4096-character sendMessage ceiling
  // (see notify.ts) they do not need one — but that is a fact about the numbers, so pin the
  // numbers. A full cart is MAX_CART_LINES items, and #145's per-item selections line roughly
  // doubles each one; even then the message is kilobytes against Resend's megabytes, and no
  // single line comes near RFC 5322's 998-octet ceiling.
  it('stays far inside the mail limits for the largest legal cart', () => {
    const items = Array.from({ length: MAX_CART_LINES }, (_, n) => ({
      name: `Chocolate chip cookie box ${n + 1} — Flavour: Chocolate chip · Size: Large · Gift box`,
      qty: 3,
      price: 12.5,
    }))
    const { subject, text, html } = build({ ...DELIVERY_ORDER, items, total: 3758 })
    // Resend caps a message at 40MB; this is three orders of magnitude under.
    expect(Buffer.byteLength(subject + text + html, 'utf8')).toBeLessThan(256 * 1024)
    const longest = (s: string) => Math.max(...s.split('\n').map(l => Buffer.byteLength(l, 'utf8')))
    expect(longest(text)).toBeLessThan(998)
    expect(Buffer.byteLength(subject, 'utf8')).toBeLessThan(998)
    // And nothing is dropped: every item the customer ordered is in the alert.
    expect(text.split('\n').filter(l => l.startsWith('• ')).length).toBe(MAX_CART_LINES)
  })
})

describe('buildMerchantOrderEmail with a banner', () => {
  it('prefixes the subject and puts the line at the top of both parts', () => {
    const banner = { line: '✅ Paid by DuitNow (HitPay)', subjectPrefix: 'Paid' }
    const mail = buildMerchantOrderEmail(PICKUP_ORDER, 'Sunny Bakes', 'https://x/merchant', banner)
    expect(mail.subject.startsWith('Paid: New order BT-260629-0052')).toBe(true)
    expect(mail.text.split('\n')[0]).toBe('✅ Paid by DuitNow (HitPay)')
    expect(mail.html).toContain('✅ Paid by DuitNow (HitPay)')
  })
  it('does not change the mail when there is no banner', () => {
    const mail = buildMerchantOrderEmail(PICKUP_ORDER, 'Sunny Bakes', 'https://x/merchant')
    expect(mail.subject.startsWith('New order')).toBe(true)
  })
})
