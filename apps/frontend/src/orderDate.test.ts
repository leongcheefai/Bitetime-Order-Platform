import { describe, it, expect, afterEach } from 'vitest'
import { formatOrderDate, formatOrderDateTime, formatCalendarDate } from './orderDate'

describe('formatOrderDate', () => {
  const iso = '2026-07-11T09:12:00Z'

  it('follows the customer\'s language', () => {
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

describe('formatCalendarDate', () => {
  const originalTz = process.env.TZ

  afterEach(() => {
    process.env.TZ = originalTz
  })

  // The whole point of this function: a stored `YYYY-MM-DD` names one day, and that day must
  // not depend on which timezone the reader's device happens to be in. `formatOrderDate` (the
  // instant formatter) DOES vary with the viewer's zone — that is what makes it wrong for a
  // calendar date, and this is the test that would have caught it: it fails under the old
  // behavior of running `formatOrderDate`-style formatting (no `timeZone: 'UTC'`) on
  // `fulfil_date`, because `America/New_York` reads UTC midnight as the previous day.
  it('renders the day the string names regardless of the viewer\'s timezone', () => {
    process.env.TZ = 'America/New_York'
    const west = formatCalendarDate('2026-07-22', 'en')
    process.env.TZ = 'Asia/Kuala_Lumpur'
    const east = formatCalendarDate('2026-07-22', 'en')
    expect(west).toBe(east)
    expect(west).toMatch(/22 Jul 2026/)
  })

  it('would have failed under formatOrderDate\'s viewer-local behavior', () => {
    process.env.TZ = 'America/New_York'
    // Proof the drift is real: the same string, run through the instant formatter, renders a
    // different day in a zone west of UTC — exactly the bug formatCalendarDate exists to avoid.
    expect(formatOrderDate('2026-07-22', 'en')).toMatch(/21 Jul 2026/)
    expect(formatCalendarDate('2026-07-22', 'en')).toMatch(/22 Jul 2026/)
  })

  it('follows the customer\'s language', () => {
    expect(formatCalendarDate('2026-07-22', 'zh')).toMatch(/2026/)
    expect(formatCalendarDate('2026-07-22', 'zh')).not.toMatch(/Jul/)
  })

  it('renders nothing for a missing or unparseable date', () => {
    expect(formatCalendarDate(null, 'en')).toBe('')
    expect(formatCalendarDate(undefined, 'en')).toBe('')
    expect(formatCalendarDate('not-a-date', 'en')).toBe('')
  })
})
