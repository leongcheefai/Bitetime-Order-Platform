import { describe, it, expect } from 'vitest'
import { receiptSubtotal } from './receipt'
import type { OrderItem } from './types'

const item = (over: Partial<OrderItem>): OrderItem => ({ id: 'p1', qty: 1, price: 0, ...over })

describe('receiptSubtotal', () => {
  it('is 0 for an order with no items', () => {
    expect(receiptSubtotal([])).toBe(0)
    expect(receiptSubtotal(null)).toBe(0)
    expect(receiptSubtotal(undefined)).toBe(0)
  })

  it('multiplies price by qty on a single line', () => {
    expect(receiptSubtotal([item({ price: 12.5, qty: 2 })])).toBe(25)
  })

  it('sums every line', () => {
    expect(receiptSubtotal([
      item({ id: 'a', price: 10, qty: 1 }),
      item({ id: 'b', price: 4.25, qty: 2 }),
    ])).toBe(18.5)
  })

  // A split promo writes TWO lines sharing one product id — 3 units at the promo
  // price plus 7 at the base price. Deduping by id here would undercharge the
  // printed subtotal against the stored total.
  it('counts both halves of a split promo separately', () => {
    expect(receiptSubtotal([
      item({ id: 'same', price: 5, qty: 3, promo: true }),
      item({ id: 'same', price: 8, qty: 7, promo: false }),
    ])).toBe(71)
  })

  it('treats a missing price or qty as zero rather than NaN', () => {
    expect(receiptSubtotal([item({ price: undefined, qty: 2 })])).toBe(0)
    expect(receiptSubtotal([{ id: 'p1' } as unknown as OrderItem])).toBe(0)
  })

  it('rounds to cents so the sum never shows float dust', () => {
    expect(receiptSubtotal([
      item({ id: 'a', price: 0.1, qty: 1 }),
      item({ id: 'b', price: 0.2, qty: 1 }),
    ])).toBe(0.3)
  })

  it('rounds each line before summing, not just the final result', () => {
    // A split promo with prices that round down individually but up when summed:
    // 0.333 × 1 = 0.333, rounds to 0.33 per line
    // 0.334 × 1 = 0.334, rounds to 0.33 per line
    // Sum of rounded per line: 0.33 + 0.33 = 0.66
    // Sum of unrounded:       0.333 + 0.334 = 0.667, which rounds to 0.67
    // This mirrors pricing.ts:153+159, which rounds each lineTotal then sums.
    expect(receiptSubtotal([
      item({ id: 'split', price: 0.333, qty: 1, promo: true }),
      item({ id: 'split', price: 0.334, qty: 1, promo: false }),
    ])).toBe(0.66)
  })
})
