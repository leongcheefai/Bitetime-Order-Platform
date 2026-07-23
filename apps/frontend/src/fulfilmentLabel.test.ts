import { describe, it, expect } from 'vitest'
import { fulfilmentLabel, feeLineLabel } from './fulfilmentLabel'

const en = (e: string) => e
const zh = (_e: string, z?: string) => z ?? _e

describe('fulfilmentLabel', () => {
  it('names each method in both languages', () => {
    expect(fulfilmentLabel('pickup', en)).toBe('Pickup')
    expect(fulfilmentLabel('delivery', en)).toBe('Delivery')
    expect(fulfilmentLabel('express', en)).toBe('Express delivery')
    expect(fulfilmentLabel('pickup', zh)).toBe('自取')
    expect(fulfilmentLabel('delivery', zh)).toBe('送货')
    expect(fulfilmentLabel('express', zh)).toBe('快速配送')
  })

  it('renders an unknown mode capitalised rather than blank', () => {
    // Rows written by older builds still have to say something in the dashboard.
    expect(fulfilmentLabel('sameday', en)).toBe('Sameday')
  })

  it('renders a missing mode as an em dash', () => {
    expect(fulfilmentLabel(null, en)).toBe('—')
    expect(fulfilmentLabel(undefined, en)).toBe('—')
  })
})

describe('feeLineLabel', () => {
  it('names the method on the fee line, and appends the distance it charged for', () => {
    expect(feeLineLabel('express', 25.2, en)).toBe('Express delivery fee (25.2 km)')
    expect(feeLineLabel('express', 25.2, zh)).toBe('快速配送费（25.2 公里）')
  })

  it('omits the distance when there is none', () => {
    // A region-priced order has no distance, and a line reading "(0.0 km)" would be a lie about
    // what produced the money.
    expect(feeLineLabel('delivery', null, en)).toBe('Delivery fee')
    expect(feeLineLabel('delivery', null, zh)).toBe('送货费')
  })
})
