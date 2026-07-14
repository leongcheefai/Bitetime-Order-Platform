import { describe, it, expect } from 'vitest'
import { priceOrder, voucherError, voucherFromRow } from './pricing.js'
import type { PricedProduct } from './pricing.js'

const RATES = { WM: 8, EM: 12 }
const NOW = new Date('2026-06-29T12:00:00')

function product(id: string, price: number, extra: Partial<PricedProduct> = {}): PricedProduct {
  return { id, name: id, price, ...extra }
}

describe('priceOrder', () => {
  it('pickup with items only: total equals subtotal, no shipping', () => {
    const r = priceOrder({
      products: [product('a', 10), product('b', 5)],
      cart: { a: 2, b: 1 },
      mode: 'pickup',
      rates: RATES,
      now: NOW,
    })
    expect(r.subtotal).toBe(25)
    expect(r.shipping).toBe(0)
    expect(r.discount).toBe(0)
    expect(r.referralDiscount).toBe(0)
    expect(r.total).toBe(25)
    expect(r.lines).toEqual([
      { id: 'a', name: 'a', qty: 2, unitPrice: 10, lineTotal: 20, promo: false },
      { id: 'b', name: 'b', qty: 1, unitPrice: 5, lineTotal: 5, promo: false },
    ])
  })

  it('delivery adds WM rate for West Malaysia state', () => {
    const r = priceOrder({
      products: [product('a', 10)], cart: { a: 1 },
      mode: 'delivery', state: 'Selangor', rates: RATES, now: NOW,
    })
    expect(r.shipping).toBe(8)
    expect(r.total).toBe(18)
  })

  it('delivery adds EM rate for East Malaysia state', () => {
    const r = priceOrder({
      products: [product('a', 10)], cart: { a: 1 },
      mode: 'delivery', state: 'Sabah', rates: RATES, now: NOW,
    })
    expect(r.shipping).toBe(12)
    expect(r.total).toBe(22)
  })

  it('sameday uses the passed-in quote fee', () => {
    const r = priceOrder({
      products: [product('a', 10)], cart: { a: 1 },
      mode: 'sameday', samedayFee: 15, rates: RATES, now: NOW,
    })
    expect(r.shipping).toBe(15)
    expect(r.total).toBe(25)
  })

  it('resolvedShipping overrides region logic (storefront with no state)', () => {
    const r = priceOrder({
      products: [product('a', 10)], cart: { a: 1 },
      mode: 'delivery', rates: RATES, now: NOW,
      resolvedShipping: 8,
    })
    expect(r.shipping).toBe(8)
    expect(r.total).toBe(18)
  })

  it('percent voucher discounts items + shipping', () => {
    const r = priceOrder({
      products: [product('a', 100)], cart: { a: 1 },
      mode: 'delivery', state: 'Selangor', rates: RATES, now: NOW,
      voucher: { code: 'X', type: 'percent', value: 10 } as any,
    })
    // (100 + 8) * 10% = 10.80
    expect(r.discount).toBe(10.8)
    expect(r.total).toBe(97.2)
  })

  it('fixed voucher is capped at the total', () => {
    const r = priceOrder({
      products: [product('a', 5)], cart: { a: 1 },
      mode: 'pickup', rates: RATES, now: NOW,
      voucher: { code: 'X', type: 'fixed', value: 20 } as any,
    })
    expect(r.discount).toBe(5)
    expect(r.total).toBe(0)
  })

  it('referral applies after voucher and is capped at the post-voucher total', () => {
    const r = priceOrder({
      products: [product('a', 100)], cart: { a: 1 },
      mode: 'pickup', rates: RATES, now: NOW,
      voucher: { code: 'X', type: 'fixed', value: 30 } as any,
      referral: { amount: 20, enabled: true },
    })
    expect(r.discount).toBe(30)
    expect(r.referralDiscount).toBe(20) // min(20, 100-30)
    expect(r.total).toBe(50)
  })

  it('referral capped at remaining total, ignored when disabled', () => {
    const capped = priceOrder({
      products: [product('a', 10)], cart: { a: 1 }, mode: 'pickup', rates: RATES, now: NOW,
      referral: { amount: 50, enabled: true },
    })
    expect(capped.referralDiscount).toBe(10)
    expect(capped.total).toBe(0)

    const disabled = priceOrder({
      products: [product('a', 10)], cart: { a: 1 }, mode: 'pickup', rates: RATES, now: NOW,
      referral: { amount: 5, enabled: false },
    })
    expect(disabled.referralDiscount).toBe(0)
    expect(disabled.total).toBe(10)
  })

  it('applies promo price when active by end date and limit', () => {
    const r = priceOrder({
      products: [product('a', 100, { promoPrice: 80, promoEnd: '2026-12-31' } as any)],
      cart: { a: 1 }, mode: 'pickup', rates: RATES, now: NOW,
    })
    expect(r.lines[0]).toMatchObject({ unitPrice: 80, promo: true })
    expect(r.total).toBe(80)
  })

  it('ignores promo when expired or limit exhausted', () => {
    const expired = priceOrder({
      products: [product('a', 100, { promoPrice: 80, promoEnd: '2026-01-01' } as any)],
      cart: { a: 1 }, mode: 'pickup', rates: RATES, now: NOW,
    })
    expect(expired.lines[0]).toMatchObject({ unitPrice: 100, promo: false })

    const exhausted = priceOrder({
      products: [product('a', 100, { promoPrice: 80, promoLimit: 5 } as any)],
      cart: { a: 1 }, mode: 'pickup', rates: RATES, now: NOW,
      promoSold: { a: 5 },
    })
    expect(exhausted.lines[0]).toMatchObject({ unitPrice: 100, promo: false })
  })

  it('appends extra lines (e.g. free referral gift) into the breakdown', () => {
    const r = priceOrder({
      products: [product('a', 10)], cart: { a: 1 }, mode: 'pickup', rates: RATES, now: NOW,
      extraLines: [{ id: 'gift', name: '🎁 Gift', qty: 1, unitPrice: 0, lineTotal: 0, promo: false }],
    })
    expect(r.lines).toHaveLength(2)
    expect(r.subtotal).toBe(10)
    expect(r.total).toBe(10)
  })
})

describe('voucherError', () => {
  const CTX = { subtotal: 50, userEmail: 'me@x.com', now: NOW }

  it('returns invalid for a missing voucher', () => {
    expect(voucherError(null, CTX)).toBe('invalid')
  })

  it('returns already_used when the user is in usedBy', () => {
    expect(voucherError({ code: 'X', usedBy: ['me@x.com'] } as any, CTX)).toBe('already_used')
  })

  it('returns not_assigned when the voucher targets another email', () => {
    expect(voucherError({ code: 'X', email: 'other@x.com' } as any, CTX)).toBe('not_assigned')
  })

  it('returns expired past expiresAt', () => {
    expect(voucherError({ code: 'X', expiresAt: '2026-01-01' } as any, CTX)).toBe('expired')
  })

  it('returns min_order when subtotal is below minOrder', () => {
    expect(voucherError({ code: 'X', minOrder: 80 } as any, CTX)).toBe('min_order')
  })

  it('honors a precomputed fullyUsed flag', () => {
    expect(voucherError({ code: 'X' } as any, { ...CTX, fullyUsed: true })).toBe('fully_used')
  })

  it('returns null for a valid voucher', () => {
    expect(voucherError({ code: 'X', minOrder: 50, email: 'me@x.com' } as any, CTX)).toBeNull()
  })
})

describe('voucherFromRow', () => {
  it('maps the vouchers row columns onto the names the discount math reads', () => {
    const v = voucherFromRow({
      id: 'v1', code: 'SAVE10', kind: 'percent', amount: '10',
      max_uses: 50, used_by: ['a@b.com'],
    })
    expect(v).toMatchObject({
      id: 'v1', code: 'SAVE10', type: 'percent', value: 10,
      maxUses: 50, usedBy: ['a@b.com'],
    })
  })

  // postgres.js hands back `numeric` as a string; supabase-js hands back a number. The
  // discount math multiplies and rounds, so a string `amount` would reach `.toFixed` and
  // throw. Both sides of the wire go through this mapper precisely so neither has to know.
  it('coerces a numeric amount to a number, whichever driver produced it', () => {
    expect(voucherFromRow({ code: 'X', kind: 'fixed', amount: '5.50' }).value).toBe(5.5)
    expect(voucherFromRow({ code: 'X', kind: 'fixed', amount: 5.5 }).value).toBe(5.5)
  })

  it('defaults a missing used_by to an empty list, never undefined', () => {
    expect(voucherFromRow({ code: 'X', kind: 'fixed', amount: 5 }).usedBy).toEqual([])
  })
})
