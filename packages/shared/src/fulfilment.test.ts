import { describe, it, expect } from 'vitest'
import {
  DEFAULT_FULFILMENT, DEFAULT_TIMEZONE, fulfilmentConfig, isTimezone,
  todayInZone, isDateSelectable, selectableDates,
} from './fulfilment.js'

// A fixed instant: 2026-07-20T04:00:00Z is 12:00 on 2026-07-20 in Kuala Lumpur (UTC+8).
const NOON_MYT = new Date('2026-07-20T04:00:00Z')
// 2026-07-20T17:00:00Z is 01:00 on the 21st in KL but still the 20th in UTC.
const LATE_MYT = new Date('2026-07-20T17:00:00Z')

const OPEN: ReturnType<typeof fulfilmentConfig> = { lead_days: 0, window_days: 3, closed_weekdays: [] }

describe('todayInZone', () => {
  it('reads the date in the shop clock, not UTC', () => {
    expect(todayInZone('Asia/Kuala_Lumpur', NOON_MYT)).toBe('2026-07-20')
  })

  it('is already tomorrow in the shop while UTC is still today', () => {
    expect(todayInZone('Asia/Kuala_Lumpur', LATE_MYT)).toBe('2026-07-21')
    expect(todayInZone('UTC', LATE_MYT)).toBe('2026-07-20')
  })

  it('falls back to the default zone rather than throwing on a junk timezone', () => {
    expect(todayInZone('Not/AZone', NOON_MYT)).toBe(todayInZone(DEFAULT_TIMEZONE, NOON_MYT))
  })
})

describe('selectableDates', () => {
  it('offers window_days days starting today when lead is 0', () => {
    expect(selectableDates(OPEN, 'Asia/Kuala_Lumpur', NOON_MYT))
      .toEqual(['2026-07-20', '2026-07-21', '2026-07-22'])
  })

  it('starts lead_days after today, and still offers window_days days', () => {
    expect(selectableDates({ ...OPEN, lead_days: 2 }, 'Asia/Kuala_Lumpur', NOON_MYT))
      .toEqual(['2026-07-22', '2026-07-23', '2026-07-24'])
  })

  it('drops closed weekdays without shortening the window', () => {
    // 2026-07-20 is a Monday (weekday 1).
    expect(selectableDates({ lead_days: 0, window_days: 3, closed_weekdays: [1] }, 'Asia/Kuala_Lumpur', NOON_MYT))
      .toEqual(['2026-07-21', '2026-07-22'])
  })

  it('is empty when every weekday is closed', () => {
    const shut = { lead_days: 0, window_days: 14, closed_weekdays: [0, 1, 2, 3, 4, 5, 6] }
    expect(selectableDates(shut, 'Asia/Kuala_Lumpur', NOON_MYT)).toEqual([])
  })
})

describe('isDateSelectable', () => {
  it('accepts the first and last day of the window', () => {
    expect(isDateSelectable('2026-07-20', OPEN, 'Asia/Kuala_Lumpur', NOON_MYT)).toBe(true)
    expect(isDateSelectable('2026-07-22', OPEN, 'Asia/Kuala_Lumpur', NOON_MYT)).toBe(true)
  })

  it('refuses the day before the window and the day after it', () => {
    expect(isDateSelectable('2026-07-19', OPEN, 'Asia/Kuala_Lumpur', NOON_MYT)).toBe(false)
    expect(isDateSelectable('2026-07-23', OPEN, 'Asia/Kuala_Lumpur', NOON_MYT)).toBe(false)
  })

  it('refuses a date inside the window that falls on a closed weekday', () => {
    const cfg = { lead_days: 0, window_days: 3, closed_weekdays: [1] }
    expect(isDateSelectable('2026-07-20', cfg, 'Asia/Kuala_Lumpur', NOON_MYT)).toBe(false)
  })

  it('refuses anything that is not a YYYY-MM-DD calendar date', () => {
    expect(isDateSelectable('2026-7-20', OPEN, 'Asia/Kuala_Lumpur', NOON_MYT)).toBe(false)
    expect(isDateSelectable('2026-02-30', OPEN, 'Asia/Kuala_Lumpur', NOON_MYT)).toBe(false)
    expect(isDateSelectable('', OPEN, 'Asia/Kuala_Lumpur', NOON_MYT)).toBe(false)
  })

  it('agrees with selectableDates', () => {
    const cfg = { lead_days: 1, window_days: 10, closed_weekdays: [0, 3] }
    for (const d of selectableDates(cfg, 'Asia/Kuala_Lumpur', NOON_MYT)) {
      expect(isDateSelectable(d, cfg, 'Asia/Kuala_Lumpur', NOON_MYT)).toBe(true)
    }
  })
})

describe('fulfilmentConfig', () => {
  it('reads a missing or empty bag as the default', () => {
    expect(fulfilmentConfig(undefined)).toEqual(DEFAULT_FULFILMENT)
    expect(fulfilmentConfig({})).toEqual(DEFAULT_FULFILMENT)
    expect(fulfilmentConfig({ fulfilment: null })).toEqual(DEFAULT_FULFILMENT)
  })

  it('reads the fulfilment key off a merchants.config bag', () => {
    expect(fulfilmentConfig({ fulfilment: { lead_days: 2, window_days: 7, closed_weekdays: [1] } }))
      .toEqual({ lead_days: 2, window_days: 7, closed_weekdays: [1] })
  })

  it('clamps out-of-range numbers instead of trusting them', () => {
    expect(fulfilmentConfig({ fulfilment: { lead_days: -5, window_days: 0, closed_weekdays: [] } }))
      .toEqual({ lead_days: 0, window_days: 1, closed_weekdays: [] })
    expect(fulfilmentConfig({ fulfilment: { lead_days: 999, window_days: 999, closed_weekdays: [] } }))
      .toEqual({ lead_days: 30, window_days: 90, closed_weekdays: [] })
  })

  it('drops junk weekdays and de-duplicates the rest', () => {
    expect(fulfilmentConfig({ fulfilment: { lead_days: 0, window_days: 14, closed_weekdays: [1, 1, 7, -1, 'x', 2.5, 6] } }))
      .toEqual({ lead_days: 0, window_days: 14, closed_weekdays: [1, 6] })
  })

  it('falls back per field, so one bad value does not discard the good ones', () => {
    expect(fulfilmentConfig({ fulfilment: { lead_days: 'soon', window_days: 7, closed_weekdays: null } }))
      .toEqual({ lead_days: 0, window_days: 7, closed_weekdays: [] })
  })
})

describe('isTimezone', () => {
  it('accepts real IANA zones', () => {
    expect(isTimezone('Asia/Kuala_Lumpur')).toBe(true)
    expect(isTimezone('UTC')).toBe(true)
  })

  it('refuses junk and non-strings', () => {
    expect(isTimezone('Not/AZone')).toBe(false)
    expect(isTimezone('')).toBe(false)
    expect(isTimezone(null)).toBe(false)
    expect(isTimezone(7)).toBe(false)
  })
})
