import { describe, it, expect } from 'vitest'
import { formatOrderDate, formatOrderDateTime } from './orderDate'

describe('formatOrderDateTime', () => {
  it('is empty for missing input', () => {
    expect(formatOrderDateTime(null, 'en')).toBe('')
    expect(formatOrderDateTime(undefined, 'en')).toBe('')
    expect(formatOrderDateTime('', 'en')).toBe('')
  })

  // "Invalid Date" on a receipt is worse than a blank — it looks like a system fault
  // where a blank just says nothing.
  it('is empty for an unparseable string', () => {
    expect(formatOrderDateTime('not-a-date', 'en')).toBe('')
  })

  it('carries the year and a wall-clock time', () => {
    const out = formatOrderDateTime('2026-07-14T06:30:00Z', 'en')
    expect(out).toContain('2026')
    expect(out).toMatch(/\d{1,2}:\d{2}/)
  })

  it('renders in Chinese when the language is zh', () => {
    const out = formatOrderDateTime('2026-07-14T06:30:00Z', 'zh')
    expect(out).toMatch(/[一-鿿]/)
  })

  // The date-only twin is unchanged and still time-free — /track and the history row
  // both depend on that.
  it('leaves formatOrderDate without a time', () => {
    expect(formatOrderDate('2026-07-14T06:30:00Z', 'en')).not.toMatch(/\d{1,2}:\d{2}/)
  })
})
