import { describe, it, expect } from 'vitest'
import { promoEndFromDate, promoEndToDate } from './promoEnd'

describe('promoEnd', () => {
  it('a date becomes the last instant of that day, locally', () => {
    const iso = promoEndFromDate('2026-07-20')!
    const d = new Date(iso)
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(6)      // July
    expect(d.getDate()).toBe(20)
    expect(d.getHours()).toBe(23)
    expect(d.getMinutes()).toBe(59)
  })

  it('round-trips', () => {
    expect(promoEndToDate(promoEndFromDate('2026-07-20'))).toBe('2026-07-20')
  })

  it('no date is no promo end', () => {
    expect(promoEndFromDate('')).toBeNull()
    expect(promoEndToDate(null)).toBe('')
    expect(promoEndToDate(undefined)).toBe('')
  })
})
