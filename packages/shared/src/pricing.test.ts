import { describe, it, expect } from 'vitest'
import {
  priceOrder, voucherError, voucherFromRow, shopRates, shopTax, DEFAULT_WM_RATE,
  promoClaims, productFromRow, promoState,
  shopDistance, routedKm, distanceFee, exceedsMaxKm,
  shopMethods, offersMethod, firstOfferedMethod,
} from './pricing.js'
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

  it('appends extra lines (e.g. a free gift line) into the breakdown', () => {
    const r = priceOrder({
      products: [product('a', 10)], cart: { a: 1 }, mode: 'pickup', rates: RATES, now: NOW,
      extraLines: [{ id: 'gift', name: '🎁 Gift', qty: 1, unitPrice: 0, lineTotal: 0, promo: false }],
    })
    expect(r.lines).toHaveLength(2)
    expect(r.subtotal).toBe(10)
    expect(r.total).toBe(10)
  })
})

const FUTURE = '2027-01-01T00:00:00.000Z'
const PAST = '2020-01-01T00:00:00.000Z'

describe('promo', () => {
  it('prices at the promo price while the promo runs', () => {
    const bd = priceOrder({
      products: [product('a', 100, { promoPrice: 80, promoEnd: FUTURE })],
      cart: { a: 2 }, mode: 'pickup', rates: { WM: 8, EM: 18 },
    })
    expect(bd.lines).toEqual([
      { id: 'a', name: 'a', qty: 2, unitPrice: 80, lineTotal: 160, promo: true },
    ])
    expect(bd.subtotal).toBe(160)
  })

  it('a promo with no cap and no end date runs anyway', () => {
    const bd = priceOrder({
      products: [product('a', 100, { promoPrice: 80 })],
      cart: { a: 1 }, mode: 'pickup', rates: { WM: 8, EM: 18 },
    })
    expect(bd.lines[0].unitPrice).toBe(80)
    expect(bd.lines[0].promo).toBe(true)
  })

  it('a promo price of 0 is a promo, not a falsy nothing', () => {
    const bd = priceOrder({
      products: [product('a', 100, { promoPrice: 0 })],
      cart: { a: 3 }, mode: 'pickup', rates: { WM: 8, EM: 18 },
    })
    expect(bd.lines[0].unitPrice).toBe(0)
    expect(bd.lines[0].promo).toBe(true)
    expect(bd.subtotal).toBe(0)
  })

  it('an elapsed promo does not apply', () => {
    const bd = priceOrder({
      products: [product('a', 100, { promoPrice: 80, promoEnd: PAST })],
      cart: { a: 1 }, mode: 'pickup', rates: { WM: 8, EM: 18 },
    })
    expect(bd.lines[0].unitPrice).toBe(100)
    expect(bd.lines[0].promo).toBe(false)
  })

  // THE CAP. A cart of 10 against 3 remaining units is 3 promo + 7 base — not 10 of either.
  it('splits the line at the cap', () => {
    const bd = priceOrder({
      products: [product('a', 100, { promoPrice: 80, promoLimit: 5, promoSold: 2 })],
      cart: { a: 10 }, mode: 'pickup', rates: { WM: 8, EM: 18 },
    })
    expect(bd.lines).toEqual([
      { id: 'a', name: 'a', qty: 3, unitPrice: 80, lineTotal: 240, promo: true },
      { id: 'a', name: 'a', qty: 7, unitPrice: 100, lineTotal: 700, promo: false },
    ])
    expect(bd.subtotal).toBe(940)
    expect(promoClaims(bd, [product('a', 100, { promoPrice: 80, promoLimit: 5, promoSold: 2 })])).toEqual({ a: 3 })
  })

  // I-1 boundary (#69 final review): the storefront card computes
  // `promo.remaining - claimed` to decide whether the NEXT unit still prices at promo. This is
  // the pricing-level proof that "claimed === remaining" really does mean the next unit is
  // base — RM 13 base, RM 8 promo, cap 3, tapped '+' three times. The card must fall back to
  // the plain base display at that point (Storefront.tsx), not keep advertising RM 8.
  it('a cart that claims the whole cap prices its next unit at base (I-1 boundary)', () => {
    const products = [product('a', 13, { promoPrice: 8, promoLimit: 3, promoSold: 0 })]
    const promo = promoState(products[0], NOW)
    expect(promo).toEqual({ price: 8, remaining: 3 })

    // Exactly the cap: every unit in the cart is still the promo — `claimed` would read 3 and
    // `remainingForNextUnit` (promo.remaining - claimed) is 0, which is the signal the card
    // acts on.
    const atCap = priceOrder({ products, cart: { a: 3 }, mode: 'pickup', rates: RATES, now: NOW })
    expect(atCap.lines).toEqual([
      { id: 'a', name: 'a', qty: 3, unitPrice: 8, lineTotal: 24, promo: true },
    ])
    const claimed = atCap.lines.find(l => l.id === 'a' && l.promo)?.qty ?? 0
    expect(claimed).toBe(3)
    expect(promo!.remaining - claimed).toBe(0)

    // One more unit is what the customer would actually get if the card's fallback failed to
    // fire and they tapped '+' a fourth time: it must price at BASE, not promo — proving the
    // headline the card shows for "the next unit" has to be base once claimed === remaining.
    const onePastCap = priceOrder({ products, cart: { a: 4 }, mode: 'pickup', rates: RATES, now: NOW })
    expect(onePastCap.lines).toEqual([
      { id: 'a', name: 'a', qty: 3, unitPrice: 8, lineTotal: 24, promo: true },
      { id: 'a', name: 'a', qty: 1, unitPrice: 13, lineTotal: 13, promo: false },
    ])
  })

  it('a sold-out cap prices the whole line at base, and claims nothing', () => {
    const products = [product('a', 100, { promoPrice: 80, promoLimit: 5, promoSold: 5 })]
    const bd = priceOrder({
      products, cart: { a: 2 }, mode: 'pickup', rates: { WM: 8, EM: 18 },
    })
    expect(bd.lines).toEqual([
      { id: 'a', name: 'a', qty: 2, unitPrice: 100, lineTotal: 200, promo: false },
    ])
    expect(promoClaims(bd, products)).toEqual({})
  })

  it('promoClaims never claims an extraLines id, even when it is flagged promo: true', () => {
    const products = [product('a', 100, { promoPrice: 80, promoEnd: FUTURE })]
    const bd = priceOrder({
      products, cart: { a: 1 }, mode: 'pickup', rates: { WM: 8, EM: 18 },
      extraLines: [{ id: 'gift', name: '🎁 Gift', qty: 1, unitPrice: 0, lineTotal: 0, promo: true }],
    })
    // the cart line for 'a' is claimed; the extra 'gift' line is not, because it never came
    // from `products` — there is no `products` row backing it to increment `promo_sold` on.
    expect(promoClaims(bd, products)).toEqual({ a: 1 })
  })

  it('promoClaims aggregates the same product id across two promo lines', () => {
    const products = [product('a', 100, { promoPrice: 80, promoEnd: FUTURE })]
    const bd = priceOrder({ products, cart: { a: 2 }, mode: 'pickup', rates: { WM: 8, EM: 18 } })
    // synthesize a second promo line for the same id, as a caller merging two carts might
    const merged = { ...bd, lines: [...bd.lines, { ...bd.lines[0], qty: 3 }] }
    expect(promoClaims(merged, products)).toEqual({ a: 5 })
  })

  it('a promo product priced alongside a normal product in one cart', () => {
    const products = [
      product('promo-item', 100, { promoPrice: 80, promoEnd: FUTURE }),
      product('normal-item', 30),
    ]
    const bd = priceOrder({
      products, cart: { 'promo-item': 1, 'normal-item': 2 }, mode: 'pickup', rates: { WM: 8, EM: 18 },
    })
    expect(bd.lines).toEqual([
      { id: 'promo-item', name: 'promo-item', qty: 1, unitPrice: 80, lineTotal: 80, promo: true },
      { id: 'normal-item', name: 'normal-item', qty: 2, unitPrice: 30, lineTotal: 60, promo: false },
    ])
    expect(bd.subtotal).toBe(140)
    expect(promoClaims(bd, products)).toEqual({ 'promo-item': 1 })
  })

  it('unrounded line totals sum to a rounded subtotal (0.1 + 0.2 display defect)', () => {
    const bd = priceOrder({
      products: [product('a', 0.1), product('b', 0.2)],
      cart: { a: 1, b: 1 }, mode: 'pickup', rates: { WM: 8, EM: 18 },
    })
    expect(bd.subtotal).toBe(0.3)
  })
})

describe('promoState', () => {
  it('promoLimit: 0 means no promo (sold out), not "uncapped"', () => {
    const p = product('a', 100, { promoPrice: 80, promoLimit: 0, promoSold: 0 })
    expect(promoState(p, NOW)).toBeNull()
  })

  it('promoSold greater than promoLimit means no promo, and promoClaims is {}', () => {
    const p = product('a', 100, { promoPrice: 80, promoLimit: 5, promoSold: 9 })
    expect(promoState(p, NOW)).toBeNull()
    const bd = priceOrder({ products: [p], cart: { a: 1 }, mode: 'pickup', rates: { WM: 8, EM: 18 }, now: NOW })
    expect(promoClaims(bd, [p])).toEqual({})
  })

  it('a promo is still live at exactly promo_end — the check is inclusive', () => {
    const end = '2027-01-01T00:00:00.000Z'
    const p = product('a', 100, { promoPrice: 80, promoEnd: end })
    expect(promoState(p, new Date(end))).toEqual({ price: 80, remaining: Infinity })
  })

  it('an unparseable promoEnd fails closed: no promo, never "runs forever"', () => {
    const p = product('a', 100, { promoPrice: 80, promoEnd: 'garbage' })
    expect(promoState(p, NOW)).toBeNull()
  })
})

describe('productFromRow', () => {
  // postgres.js hands back `numeric` as a STRING. Unmapped, '80.00' reaches round2's .toFixed()
  // and throws — and the two sides of the wire price differently, which is a refused checkout.
  it('coerces postgres.js numerics and maps the promo columns', () => {
    const p = productFromRow({
      id: 'a', name: 'Nasi', price: '100.00',
      promo_price: '80.00', promo_limit: 5, promo_sold: 2,
      promo_end: '2027-01-01T00:00:00.000Z',
    })
    expect(p.price).toBe(100)
    expect(p.promoPrice).toBe(80)
    expect(p.promoLimit).toBe(5)
    expect(p.promoSold).toBe(2)
    expect(p.promoEnd).toBe('2027-01-01T00:00:00.000Z')
  })

  it('a row with no promo maps to no promo, and 0 survives', () => {
    expect(productFromRow({ id: 'a', name: 'a', price: 10, promo_price: null }).promoPrice).toBeNull()
    expect(productFromRow({ id: 'a', name: 'a', price: 10, promo_price: '0' }).promoPrice).toBe(0)
  })

  // Unreachable from a real timestamptz column, but this mapper is the module's public front
  // door: `new Date('garbage').toISOString()` throws a RangeError, which would turn into a 500
  // mid-checkout instead of a plain refusal.
  it('an unparseable promo_end maps to null, rather than throwing', () => {
    expect(() => productFromRow({ id: 'a', name: 'a', price: 10, promo_end: 'garbage' })).not.toThrow()
    expect(productFromRow({ id: 'a', name: 'a', price: 10, promo_end: 'garbage' }).promoEnd).toBeNull()
  })

  // products.price is `numeric not null`, so this is unreachable from a real row — but it is
  // the one default in this file that would round money DOWN, and a select that forgot the
  // column must not ship the item for free.
  it('throws rather than defaulting a missing/unparseable price to 0', () => {
    expect(() => productFromRow({ id: 'a', name: 'a', price: null })).toThrow()
    expect(() => productFromRow({ id: 'a', name: 'a', price: 'not-a-number' })).toThrow()
    expect(() => productFromRow({ id: 'a', name: 'a' })).toThrow()
  })

  // The doc comment promises the row is spread through untouched; nothing checked that.
  it('preserves untouched columns the pricing rule does not read', () => {
    const p = productFromRow({
      id: 'a', name: 'a', price: 10,
      image_urls: ['x.jpg'], unit: 'plate', active: true,
    })
    expect(p.image_urls).toEqual(['x.jpg'])
    expect(p.unit).toBe('plate')
    expect(p.active).toBe(true)
  })

  // The wire is not pinned shut by any test otherwise: PricedProduct keeps an index signature,
  // so a raw snake_case row type-checks fine with promoPrice: undefined — silent no-promo. This
  // pins the two real driver shapes (postgres.js vs. PostgREST) to an identical breakdown.
  it('both drivers price a promo identically — this is what holds the wire shut', () => {
    // postgres.js (backend): numerics arrive as STRINGS, timestamptz as a Date.
    const pg = productFromRow({
      id: 'a', name: 'a', price: '100.00', promo_price: '80.00',
      promo_limit: 5, promo_sold: 2, promo_end: new Date('2027-01-01T00:00:00Z'),
    })
    // PostgREST (browser): numerics arrive as NUMBERS, timestamptz as an ISO string.
    const rest = productFromRow({
      id: 'a', name: 'a', price: 100, promo_price: 80,
      promo_limit: 5, promo_sold: 2, promo_end: '2027-01-01T00:00:00+00:00',
    })
    const opts = { cart: { a: 10 }, mode: 'pickup' as const, rates: { WM: 8, EM: 18 } }
    expect(priceOrder({ products: [pg], ...opts })).toEqual(priceOrder({ products: [rest], ...opts }))
  })
})

describe('voucherError', () => {
  const CTX = { userEmail: 'me@x.com' }

  it('returns invalid for a missing voucher', () => {
    expect(voucherError(null, CTX)).toBe('invalid')
  })

  it('returns already_used when the user is in usedBy', () => {
    expect(voucherError({ code: 'X', usedBy: ['me@x.com'] } as any, CTX)).toBe('already_used')
  })

  it('honors a precomputed fullyUsed flag', () => {
    expect(voucherError({ code: 'X' } as any, { ...CTX, fullyUsed: true })).toBe('fully_used')
  })

  it('returns null for a valid voucher', () => {
    expect(voucherError({ code: 'X' } as any, CTX)).toBeNull()
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

// The two callers of priceOrder must agree to the cent — the backend REFUSES a quote it
// disagrees with — so the fallbacks are pinned here rather than in each caller.
describe('shopRates', () => {
  it('reads both rates off a well-formed shipping row', () => {
    expect(shopRates({ WM: 8, EM: 18 })).toEqual({ WM: 8, EM: 18 })
  })

  // A shop that named one rate charges it everywhere. Falling back to 0 would ship to East
  // Malaysia for free — a fee zeroed by a value nobody chose.
  it('falls a missing EM back to WM, never to free shipping', () => {
    expect(shopRates({ WM: 12 })).toEqual({ WM: 12, EM: 12 })
  })

  it('falls a missing WM back to the column default', () => {
    expect(shopRates({ EM: 20 })).toEqual({ WM: DEFAULT_WM_RATE, EM: 20 })
  })

  it('falls a null/undefined/non-object shipping value back to the column default, both regions', () => {
    const both = { WM: DEFAULT_WM_RATE, EM: DEFAULT_WM_RATE }
    expect(shopRates(null)).toEqual(both)
    expect(shopRates(undefined)).toEqual(both)
    expect(shopRates({})).toEqual(both)
    expect(shopRates('nonsense')).toEqual(both)
  })

  // A zero a merchant actually TYPED is free shipping and is honoured — only an absent key
  // falls back.
  it('honours a rate of 0 that is really there', () => {
    expect(shopRates({ WM: 0, EM: 0 })).toEqual({ WM: 0, EM: 0 })
  })

  // jsonb can carry a number as a string, and an unusable value must not become NaN — that
  // is what reaches round2's .toFixed() and throws.
  it('coerces a numeric string, and refuses anything that is not a number', () => {
    expect(shopRates({ WM: '8.50', EM: '18' })).toEqual({ WM: 8.5, EM: 18 })
    expect(shopRates({ WM: 'abc', EM: null })).toEqual({ WM: DEFAULT_WM_RATE, EM: DEFAULT_WM_RATE })
  })
})

describe('tax', () => {
  const products = [{ id: 'a', name: 'Nasi Lemak', price: 10 }]
  const cart = { a: 2 }
  const rates = { WM: 8, EM: 18 }

  it('is absent when no tax is configured — today\'s numbers, unchanged', () => {
    const bd = priceOrder({ products, cart, mode: 'delivery', state: 'Selangor', rates })
    expect(bd.subtotal).toBe(20)
    expect(bd.shipping).toBe(8)
    expect(bd.tax).toBe(0)
    expect(bd.taxRate).toBe(0)
    expect(bd.total).toBe(28)
  })

  it('is absent when tax is configured but disabled', () => {
    const bd = priceOrder({
      products, cart, mode: 'pickup', rates,
      tax: { enabled: false, rate: 6 },
    })
    expect(bd.tax).toBe(0)
    expect(bd.taxRate).toBe(0)
    expect(bd.total).toBe(20)
  })

  it('adds tax on the subtotal, and never on shipping', () => {
    const bd = priceOrder({
      products, cart, mode: 'delivery', state: 'Selangor', rates,
      tax: { enabled: true, rate: 6 },
    })
    // 6% of 20 = 1.20. The RM8 delivery fee is NOT taxed.
    expect(bd.tax).toBe(1.2)
    expect(bd.taxRate).toBe(6)
    expect(bd.total).toBe(29.2) // 20 + 8 + 1.20
  })

  it('taxes the subtotal AFTER the voucher comes off', () => {
    const bd = priceOrder({
      products, cart, mode: 'pickup', rates,
      voucher: { code: 'X', type: 'fixed', value: 5 },
      tax: { enabled: true, rate: 6 },
    })
    // discount 5 off (20 + 0); taxable base 20 − 5 = 15; tax 0.90
    expect(bd.discount).toBe(5)
    expect(bd.tax).toBe(0.9)
    expect(bd.total).toBe(15.9)
  })

  it('never charges a negative tax when the voucher exceeds the subtotal', () => {
    const bd = priceOrder({
      products, cart, mode: 'delivery', state: 'Selangor', rates,
      voucher: { code: 'X', type: 'fixed', value: 25 },
      tax: { enabled: true, rate: 6 },
    })
    // discount is min(25, 20 + 8) = 25, which is MORE than the 20 subtotal.
    // Base clamps to 0 — an unclamped base would be a tax that pays the customer.
    expect(bd.discount).toBe(25)
    expect(bd.tax).toBe(0)
    expect(bd.total).toBe(3)
  })

  it('rounds tax to cents', () => {
    const bd = priceOrder({
      products: [{ id: 'a', name: 'Kopi', price: 3.33 }], cart: { a: 1 },
      mode: 'pickup', rates,
      tax: { enabled: true, rate: 6 },
    })
    expect(bd.tax).toBe(0.2) // 3.33 * 0.06 = 0.1998
    expect(bd.total).toBe(3.53)
  })

  it('carries a fractional rate through to the breakdown', () => {
    const bd = priceOrder({
      products, cart, mode: 'pickup', rates,
      tax: { enabled: true, rate: 6.5 },
    })
    expect(bd.taxRate).toBe(6.5)
    expect(bd.tax).toBe(1.3)
  })
})

describe('shopTax', () => {
  it('reads an enabled rate off a merchant row', () => {
    expect(shopTax({ tax_enabled: true, tax_rate: 6 })).toEqual({ enabled: true, rate: 6 })
  })

  it('is OFF for a shop that never configured tax', () => {
    const off = { enabled: false, rate: 0 }
    expect(shopTax(null)).toEqual(off)
    expect(shopTax(undefined)).toEqual(off)
    expect(shopTax({})).toEqual(off)
    expect(shopTax('nonsense')).toEqual(off)
  })

  it('is OFF when the flag is false, even with a rate stored', () => {
    expect(shopTax({ tax_enabled: false, tax_rate: 6 })).toEqual({ enabled: false, rate: 6 })
  })

  it('coerces the string a postgres.js numeric arrives as', () => {
    // postgres.js hands back '6.00'; PostgREST hands back 6. Two sides mapping
    // differently is a refused checkout for every order at the shop.
    expect(shopTax({ tax_enabled: true, tax_rate: '6.00' })).toEqual({ enabled: true, rate: 6 })
    expect(shopTax({ tax_enabled: true, tax_rate: '6.50' })).toEqual({ enabled: true, rate: 6.5 })
  })

  it('fails to NO tax on an unparseable rate, never to a number nobody chose', () => {
    expect(shopTax({ tax_enabled: true, tax_rate: 'abc' })).toEqual({ enabled: false, rate: 0 })
    expect(shopTax({ tax_enabled: true, tax_rate: null })).toEqual({ enabled: false, rate: 0 })
  })

  it('treats an enabled 0% as no tax', () => {
    expect(shopTax({ tax_enabled: true, tax_rate: 0 })).toEqual({ enabled: false, rate: 0 })
  })
})

const DISTANCE_ROW = {
  shipping_mode: 'distance',
  delivery_base_fee: 6,
  delivery_rate_per_km: 1,
  delivery_max_km: null,
  origin_place_id: 'ChIJorigin',
}

describe('shopDistance', () => {
  it('maps a distance-mode row and reports it usable', () => {
    expect(shopDistance(DISTANCE_ROW)).toEqual({
      mode: 'distance', base: 6, ratePerKm: 1, maxKm: null,
      originPlaceId: 'ChIJorigin', usable: true,
    })
  })

  it('maps postgres.js strings identically to PostgREST numbers', () => {
    // THE CROSS-DRIVER TRAP: postgres.js returns `numeric` as a STRING ('6.00'), PostgREST as a
    // number. The browser quotes from one and the backend charges from the other; mapping only
    // one side is a `price_changed` refusal on every distance order at that shop.
    expect(shopDistance({
      shipping_mode: 'distance',
      delivery_base_fee: '6.00',
      delivery_rate_per_km: '1.00',
      delivery_max_km: '20.0',
      origin_place_id: 'ChIJorigin',
    })).toEqual(shopDistance({ ...DISTANCE_ROW, delivery_max_km: 20 }))
  })

  it('reads a region-mode row as region and never as a broken distance shop', () => {
    const p = shopDistance({ shipping_mode: 'region', delivery_base_fee: 6, origin_place_id: null })
    expect(p.mode).toBe('region')
  })

  it('treats a missing shipping_mode as region — every shop that predates this feature', () => {
    expect(shopDistance({}).mode).toBe('region')
    expect(shopDistance(null).mode).toBe('region')
  })

  it('is UNUSABLE, never zero-rated, when a distance shop has no origin', () => {
    expect(shopDistance({ ...DISTANCE_ROW, origin_place_id: null }).usable).toBe(false)
  })

  it('is UNUSABLE when a rate is unparseable or negative', () => {
    expect(shopDistance({ ...DISTANCE_ROW, delivery_rate_per_km: null }).usable).toBe(false)
    expect(shopDistance({ ...DISTANCE_ROW, delivery_rate_per_km: -1 }).usable).toBe(false)
    expect(shopDistance({ ...DISTANCE_ROW, delivery_base_fee: -0.5 }).usable).toBe(false)
  })

  it('accepts an honest zero base and an honest zero rate', () => {
    expect(shopDistance({ ...DISTANCE_ROW, delivery_base_fee: 0 }).usable).toBe(true)
    expect(shopDistance({ ...DISTANCE_ROW, delivery_rate_per_km: 0 }).usable).toBe(true)
  })

  it('keeps a null maximum as "no limit" and rejects a non-positive one', () => {
    expect(shopDistance(DISTANCE_ROW).maxKm).toBeNull()
    expect(shopDistance({ ...DISTANCE_ROW, delivery_max_km: 0 }).usable).toBe(false)
  })
})

describe('routedKm / distanceFee', () => {
  const policy = shopDistance(DISTANCE_ROW)

  it('reproduces the reference image exactly: 25216 m at 6.00 + 1.00/km is 25.2 km and 31.20', () => {
    const km = routedKm(25216)
    expect(km).toBe(25.2)
    expect(distanceFee(policy, km)).toBe(31.2)
  })

  it('rounds the km BEFORE the rate multiplies it', () => {
    // Rounding after would give 25.22 here, printed beside a line that says 25.2 km. A receipt
    // line that does not reconcile on a calculator is a support ticket.
    const pureRate = shopDistance({ ...DISTANCE_ROW, delivery_base_fee: 0 })
    expect(distanceFee(pureRate, routedKm(25216))).toBe(25.2)
  })

  it('rounds the km half-up and half-down', () => {
    // The real tie. 25.25 is exactly representable in binary, so `toFixed(1)` rounds it half-up
    // deterministically rather than at the mercy of a float that is really 25.249999…
    expect(routedKm(25250)).toBe(25.3)
    expect(routedKm(25260)).toBe(25.3)
    expect(routedKm(25240)).toBe(25.2)
    expect(routedKm(0)).toBe(0)
  })

  it('prices a zero base as pure per-km and a zero rate as a flat base', () => {
    expect(distanceFee(shopDistance({ ...DISTANCE_ROW, delivery_base_fee: 0, delivery_rate_per_km: 2 }), routedKm(3000))).toBe(6)
    expect(distanceFee(shopDistance({ ...DISTANCE_ROW, delivery_rate_per_km: 0 }), routedKm(12345))).toBe(6)
  })

  it('reports a distance beyond the shop maximum, and never with a null maximum', () => {
    const capped = shopDistance({ ...DISTANCE_ROW, delivery_max_km: 20 })
    expect(exceedsMaxKm(capped, 20)).toBe(false)   // inclusive: exactly at the cap still delivers
    expect(exceedsMaxKm(capped, 20.1)).toBe(true)
    expect(exceedsMaxKm(shopDistance(DISTANCE_ROW), 999)).toBe(false)
  })
})

describe('priceOrder under a distance policy', () => {
  const distance = shopDistance(DISTANCE_ROW)

  it('charges base + rate x rounded km for a delivery', () => {
    const r = priceOrder({
      products: [product('a', 10)], cart: { a: 1 },
      mode: 'delivery', state: 'Selangor', rates: RATES, now: NOW,
      distance, routedMetres: 25216,
    })
    expect(r.shipping).toBe(31.2)
    expect(r.shippingPending).toBe(false)
    expect(r.total).toBe(41.2)
  })

  it('ignores the shop region rates entirely — the dormant policy must never leak into a total', () => {
    const r = priceOrder({
      products: [product('a', 10)], cart: { a: 1 },
      mode: 'delivery', state: 'Sabah', rates: { WM: 8, EM: 999 }, now: NOW,
      distance, routedMetres: 25216,
    })
    expect(r.shipping).toBe(31.2)
  })

  it('charges NOTHING and flags the fee pending when the distance is not known yet', () => {
    const r = priceOrder({
      products: [product('a', 10)], cart: { a: 1 },
      mode: 'delivery', state: 'Selangor', rates: RATES, now: NOW,
      distance, routedMetres: null,
    })
    expect(r.shipping).toBe(0)
    expect(r.shippingPending).toBe(true)
  })

  it('flags pending — never a fee — for a distance shop whose configuration cannot price', () => {
    const broken = shopDistance({ ...DISTANCE_ROW, delivery_rate_per_km: null })
    const r = priceOrder({
      products: [product('a', 10)], cart: { a: 1 },
      mode: 'delivery', state: 'Selangor', rates: RATES, now: NOW,
      distance: broken, routedMetres: 25216,
    })
    expect(r.shipping).toBe(0)
    expect(r.shippingPending).toBe(true)
  })

  it('charges no shipping on a pickup at a distance shop, and never flags it pending', () => {
    const r = priceOrder({
      products: [product('a', 10)], cart: { a: 1 },
      mode: 'pickup', rates: RATES, now: NOW, distance, routedMetres: null,
    })
    expect(r.shipping).toBe(0)
    expect(r.shippingPending).toBe(false)
  })

  it('discounts a percent voucher off subtotal PLUS the distance fee, unchanged', () => {
    // Deliberately unchanged (#101 "What deliberately does not change"): moving the discount
    // base would shift totals at every shop that never asked for distance pricing.
    const r = priceOrder({
      products: [product('a', 10)], cart: { a: 1 },
      mode: 'delivery', state: 'Selangor', rates: RATES, now: NOW,
      distance, routedMetres: 25216,
      voucher: { code: 'X', type: 'percent', value: 20 },
    })
    expect(r.discount).toBe(8.24) // 20% of 41.20
  })

  it('flags pending — never a reduced fee — for a negative routed distance', () => {
    const r = priceOrder({
      products: [product('a', 10)], cart: { a: 1 },
      mode: 'delivery', state: 'Selangor', rates: RATES, now: NOW,
      distance, routedMetres: -5000,
    })
    expect(r.shipping).toBe(0)
    expect(r.shippingPending).toBe(true)
  })
})

describe('shopMethods', () => {
  it('reads the three flags off the row', () => {
    expect(shopMethods({ pickup_enabled: true, delivery_enabled: false, express_enabled: true }))
      .toEqual({ pickup: true, delivery: false, express: true })
  })

  it('falls back to each column\'s own default for a row that predates them', () => {
    // A pre-#103 row, or a fixture that names none of them: the shop is exactly what it was
    // before this feature — pickup and delivery on, express off.
    expect(shopMethods({})).toEqual({ pickup: true, delivery: true, express: false })
    expect(shopMethods(null)).toEqual({ pickup: true, delivery: true, express: false })
  })

  it('honours an explicit false', () => {
    expect(shopMethods({ pickup_enabled: false }).pickup).toBe(false)
  })

  it('treats a non-boolean as absent rather than coercing it', () => {
    // Both drivers hand these back as real booleans. Anything else is a fixture or a bug, and
    // guessing what 'false' or 0 meant is how a shop starts offering a method it switched off.
    expect(shopMethods({ pickup_enabled: 'false' }).pickup).toBe(true)
    expect(shopMethods({ express_enabled: 1 }).express).toBe(false)
  })

  it('reports all-false as all-false — it does not fall back to pickup', () => {
    // FAILS CLOSED. A shop offering nothing takes no order; inventing pickup here would offer a
    // method the merchant switched off. Unreachable past merchants_one_fulfilment_method, and
    // guarded anyway, because that is the direction this whole family fails in.
    const none = { pickup_enabled: false, delivery_enabled: false, express_enabled: false }
    expect(shopMethods(none)).toEqual({ pickup: false, delivery: false, express: false })
    expect(firstOfferedMethod(shopMethods(none))).toBeNull()
  })
})

describe('offersMethod', () => {
  const methods = { pickup: true, delivery: false, express: true }

  it('answers for each of the three methods', () => {
    expect(offersMethod(methods, 'pickup')).toBe(true)
    expect(offersMethod(methods, 'delivery')).toBe(false)
    expect(offersMethod(methods, 'express')).toBe(true)
  })

  it('refuses a mode that is not a method at all', () => {
    expect(offersMethod(methods, 'sameday')).toBe(false)
    expect(offersMethod(methods, '')).toBe(false)
  })
})

describe('firstOfferedMethod', () => {
  it('prefers pickup, then delivery, then express', () => {
    expect(firstOfferedMethod({ pickup: true, delivery: true, express: true })).toBe('pickup')
    expect(firstOfferedMethod({ pickup: false, delivery: true, express: true })).toBe('delivery')
    expect(firstOfferedMethod({ pickup: false, delivery: false, express: true })).toBe('express')
  })
})

describe('region pricing is untouched', () => {
  it('produces the same money with and without the distance fields present', () => {
    const base = {
      products: [product('a', 10)], cart: { a: 2 },
      mode: 'delivery' as const, state: 'Sabah', rates: RATES, now: NOW,
      tax: { enabled: true, rate: 6 },
    }
    const before = priceOrder(base)
    const after = priceOrder({ ...base, distance: shopDistance({ shipping_mode: 'region' }), routedMetres: 25216 })
    expect(after.shipping).toBe(before.shipping)
    expect(after.subtotal).toBe(before.subtotal)
    expect(after.discount).toBe(before.discount)
    expect(after.tax).toBe(before.tax)
    expect(after.total).toBe(before.total)
    expect(after.shippingPending).toBe(false)
  })
})
