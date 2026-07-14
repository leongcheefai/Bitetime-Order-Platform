// tests/unit/orderNumber.test.ts
// The order-number format, pinned.
//
// These numbers are printed on receipts, pasted into the tracking page and quoted to
// merchants over WhatsApp. Porting them out of PL/pgSQL must not move a single character —
// so the two things the SQL chose and nobody should re-litigate here are asserted directly:
// the day is YYMMDD (CLAUDE.md said YYYYMMDD; CLAUDE.md was wrong) and the counter starts
// at 50, not 1.
import { describe, it, expect } from 'vitest'
import { orderDay, formatOrderNumber, COUNTER_START } from '../../src/orderNumber.js'

describe('orderDay', () => {
  it('is YYMMDD — six digits, not eight', () => {
    expect(orderDay(new Date('2026-07-14T09:30:00Z'))).toBe('260714')
  })

  it('zero-pads month and day', () => {
    expect(orderDay(new Date('2026-01-05T00:00:00Z'))).toBe('260105')
  })
})

describe('formatOrderNumber', () => {
  it('is PREFIX-YYMMDD-NNNN', () => {
    expect(formatOrderNumber('VE', '260714', 50)).toBe('VE-260714-0050')
  })

  it('pads the counter to four digits', () => {
    expect(formatOrderNumber('VE', '260714', 7)).toBe('VE-260714-0007')
  })

  it('does not truncate a counter past four digits', () => {
    expect(formatOrderNumber('VE', '260714', 12345)).toBe('VE-260714-12345')
  })
})

describe('COUNTER_START', () => {
  // The SQL seeded a new day at 50 so a shop's first order of the day does not advertise
  // that it is their first. Changing this changes customer-visible numbers.
  it('is 50, so the first order of a day is -0050', () => {
    expect(COUNTER_START).toBe(50)
    expect(formatOrderNumber('VE', '260714', COUNTER_START)).toBe('VE-260714-0050')
  })
})
