import { describe, it, expect } from 'vitest'
import { formatOrderDate } from './orderDate'

describe('formatOrderDate', () => {
  const iso = '2026-07-11T09:12:00Z'

  it('follows the customer’s language', () => {
    expect(formatOrderDate(iso, 'en')).toMatch(/2026/)
    expect(formatOrderDate(iso, 'en')).toMatch(/Jul/)
    expect(formatOrderDate(iso, 'zh')).toMatch(/2026/)
    // The Chinese locale writes the month as 7月, never as an English abbreviation.
    expect(formatOrderDate(iso, 'zh')).not.toMatch(/Jul/)
  })

  it('renders nothing for a missing or unparseable date rather than "Invalid Date"', () => {
    expect(formatOrderDate(null, 'en')).toBe('')
    expect(formatOrderDate(undefined, 'en')).toBe('')
    expect(formatOrderDate('not-a-date', 'en')).toBe('')
  })
})
