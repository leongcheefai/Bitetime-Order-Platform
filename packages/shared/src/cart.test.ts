import { describe, it, expect } from 'vitest'
import { isCart, MAX_CART_QTY, MAX_CART_LINES } from './cart.js'

const ID = '11111111-1111-1111-1111-111111111111'

/** A cart of `n` distinct lines, one of each. */
const lines = (n: number) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`id-${i}`, 1]))

describe('isCart', () => {
  it('accepts ids mapped to positive whole quantities', () => {
    expect(isCart({ [ID]: 1 })).toBe(true)
    expect(isCart({ a: 2, b: 3 })).toBe(true)
  })

  it('rejects a cart that is not an object of quantities', () => {
    expect(isCart(null)).toBe(false)
    expect(isCart('a')).toBe(false)
    expect(isCart([])).toBe(false)
    expect(isCart([[ID, 1]])).toBe(false)
  })

  // An empty cart would price to nothing and commit an order for no products.
  it('rejects an empty cart', () => {
    expect(isCart({})).toBe(false)
  })

  it('rejects a quantity that is not a positive whole number', () => {
    expect(isCart({ [ID]: 'abc' })).toBe(false)
    expect(isCart({ [ID]: 1.5 })).toBe(false)
    expect(isCart({ [ID]: 0 })).toBe(false)
    expect(isCart({ [ID]: -1 })).toBe(false)
    expect(isCart({ [ID]: NaN })).toBe(false)
  })

  // The caps are the whole reason this module is shared: the storefront stops the customer at
  // the same number the backend refuses at, so the UI cannot build a cart that is dead on
  // arrival. Assert the BOUNDARY, not a round number near it.
  describe('the caps', () => {
    it('accepts exactly MAX_CART_QTY of one product and refuses one more', () => {
      expect(isCart({ [ID]: MAX_CART_QTY })).toBe(true)
      expect(isCart({ [ID]: MAX_CART_QTY + 1 })).toBe(false)
    })

    // `Number.isInteger(1e21)` is TRUE. Without the cap this is an order for a sextillion
    // cookies, and the price check agrees with it — the client quotes the same absurd total.
    it('refuses an absurd quantity that is nonetheless a whole number', () => {
      expect(Number.isInteger(1e21)).toBe(true)
      expect(isCart({ [ID]: 1e21 })).toBe(false)
    })

    it('accepts exactly MAX_CART_LINES distinct products and refuses one more', () => {
      expect(isCart(lines(MAX_CART_LINES))).toBe(true)
      expect(isCart(lines(MAX_CART_LINES + 1))).toBe(false)
    })
  })
})
