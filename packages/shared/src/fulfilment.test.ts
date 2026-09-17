import { describe, it, expect } from 'vitest'
import {
  DEFAULT_FULFILMENT, DEFAULT_TIMEZONE, fulfilmentConfig, isTimezone,
  todayInZone, isDateSelectable, selectableDates,
  FULFILMENT_HORIZON_DAYS, MAX_CUSTOM_DATES, DATES_ENDING_SOON_DAYS,
  customDateBounds, pruneCustomDates, validateCustomDates, fulfilmentWarning,
  timeToMinutes, minutesToTime,
  selectableSlots, isSlotSelectable, slotsBetween, validateSlotHours, minutesInZone,
  type FulfilmentConfig,
} from './fulfilment.js'

// A fixed instant: 2026-07-20T04:00:00Z is 12:00 on 2026-07-20 in Kuala Lumpur (UTC+8).
const NOON_MYT = new Date('2026-07-20T04:00:00Z')
// 2026-07-20T17:00:00Z is 01:00 on the 21st in KL but still the 20th in UTC.
const LATE_MYT = new Date('2026-07-20T17:00:00Z')

const KL = 'Asia/Kuala_Lumpur'

// Every fixture spreads the default so a new field cannot silently read as `undefined` here while
// reading as its fallback everywhere else.
const OPEN: FulfilmentConfig = { ...DEFAULT_FULFILMENT, window_days: 3 }

/** A `custom` config built the way the app builds one — through the parser, never by hand. */
const custom = (dates: string[], over: Record<string, unknown> = {}): FulfilmentConfig =>
  fulfilmentConfig({ fulfilment: { mode: 'custom', custom_dates: dates, ...over } })

/** `count` consecutive calendar dates from `2026-07-21`, as strings. */
const consecutive = (count: number, fromMs = Date.UTC(2026, 6, 21)): string[] =>
  Array.from({ length: count }, (_, i) => {
    const d = new Date(fromMs + i * 86_400_000)
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  })

describe('todayInZone', () => {
  it('reads the date in the shop clock, not UTC', () => {
    expect(todayInZone(KL, NOON_MYT)).toBe('2026-07-20')
  })

  it('is already tomorrow in the shop while UTC is still today', () => {
    expect(todayInZone(KL, LATE_MYT)).toBe('2026-07-21')
    expect(todayInZone('UTC', LATE_MYT)).toBe('2026-07-20')
  })

  it('falls back to the default zone rather than throwing on a junk timezone', () => {
    expect(todayInZone('Not/AZone', NOON_MYT)).toBe(todayInZone(DEFAULT_TIMEZONE, NOON_MYT))
  })
})

describe('selectableDates', () => {
  it('offers window_days days starting today when lead is 0', () => {
    expect(selectableDates(OPEN, KL, NOON_MYT))
      .toEqual(['2026-07-20', '2026-07-21', '2026-07-22'])
  })

  it('starts lead_days after today, and still offers window_days days', () => {
    expect(selectableDates({ ...OPEN, lead_days: 2 }, KL, NOON_MYT))
      .toEqual(['2026-07-22', '2026-07-23', '2026-07-24'])
  })

  it('drops closed weekdays without shortening the window', () => {
    // 2026-07-20 is a Monday (weekday 1).
    expect(selectableDates({ ...OPEN, closed_weekdays: [1] }, KL, NOON_MYT))
      .toEqual(['2026-07-21', '2026-07-22'])
  })

  it('is empty when every weekday is closed', () => {
    const shut: FulfilmentConfig = { ...DEFAULT_FULFILMENT, closed_weekdays: [0, 1, 2, 3, 4, 5, 6] }
    expect(selectableDates(shut, KL, NOON_MYT)).toEqual([])
  })
})

describe('isDateSelectable', () => {
  it('accepts the first and last day of the window', () => {
    expect(isDateSelectable('2026-07-20', OPEN, KL, NOON_MYT)).toBe(true)
    expect(isDateSelectable('2026-07-22', OPEN, KL, NOON_MYT)).toBe(true)
  })

  it('refuses the day before the window and the day after it', () => {
    expect(isDateSelectable('2026-07-19', OPEN, KL, NOON_MYT)).toBe(false)
    expect(isDateSelectable('2026-07-23', OPEN, KL, NOON_MYT)).toBe(false)
  })

  it('refuses a date inside the window that falls on a closed weekday', () => {
    expect(isDateSelectable('2026-07-20', { ...OPEN, closed_weekdays: [1] }, KL, NOON_MYT)).toBe(false)
  })

  it('refuses anything that is not a YYYY-MM-DD calendar date', () => {
    expect(isDateSelectable('2026-7-20', OPEN, KL, NOON_MYT)).toBe(false)
    expect(isDateSelectable('2026-02-30', OPEN, KL, NOON_MYT)).toBe(false)
    expect(isDateSelectable('', OPEN, KL, NOON_MYT)).toBe(false)
  })

  it('agrees with selectableDates', () => {
    const cfg: FulfilmentConfig = { ...DEFAULT_FULFILMENT, lead_days: 1, window_days: 10, closed_weekdays: [0, 3] }
    for (const d of selectableDates(cfg, KL, NOON_MYT)) {
      expect(isDateSelectable(d, cfg, KL, NOON_MYT)).toBe(true)
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
      .toEqual({ ...DEFAULT_FULFILMENT, lead_days: 2, window_days: 7, closed_weekdays: [1] })
  })

  it('clamps out-of-range numbers instead of trusting them', () => {
    expect(fulfilmentConfig({ fulfilment: { lead_days: -5, window_days: 0, closed_weekdays: [] } }))
      .toEqual({ ...DEFAULT_FULFILMENT, lead_days: 0, window_days: 1, closed_weekdays: [] })
    expect(fulfilmentConfig({ fulfilment: { lead_days: 999, window_days: 999, closed_weekdays: [] } }))
      .toEqual({ ...DEFAULT_FULFILMENT, lead_days: 30, window_days: 90, closed_weekdays: [] })
  })

  it('drops junk weekdays and de-duplicates the rest', () => {
    expect(fulfilmentConfig({ fulfilment: { lead_days: 0, window_days: 14, closed_weekdays: [1, 1, 7, -1, 'x', 2.5, 6] } }))
      .toEqual({ ...DEFAULT_FULFILMENT, closed_weekdays: [1, 6] })
  })

  it('falls back per field, so one bad value does not discard the good ones', () => {
    expect(fulfilmentConfig({ fulfilment: { lead_days: 'soon', window_days: 7, closed_weekdays: null } }))
      .toEqual({ ...DEFAULT_FULFILMENT, window_days: 7 })
  })
})

describe('fulfilmentConfig — mode', () => {
  it('reads a shop that predates this feature as rolling, with an empty allowlist', () => {
    const cfg = fulfilmentConfig({ fulfilment: { lead_days: 1, window_days: 7 } })
    expect(cfg.mode).toBe('rolling')
    expect(cfg.custom_dates).toEqual([])
    expect(cfg.needs_review).toBe(false)
  })

  it('reads an unknown mode as rolling rather than throwing', () => {
    expect(fulfilmentConfig({ fulfilment: { mode: 'weekends' } }).mode).toBe('rolling')
  })

  it('sorts, dedupes and drops junk from custom_dates without touching the other fields', () => {
    const cfg = fulfilmentConfig({
      fulfilment: {
        mode: 'custom', lead_days: 2, window_days: 5, closed_weekdays: [0],
        custom_dates: ['2026-08-20', '2026-08-13', '2026-08-13', '2026-02-30', 'nonsense', 42],
      },
    })
    expect(cfg.custom_dates).toEqual(['2026-08-13', '2026-08-20'])
    // The rolling fields survive intact — switching mode is never a deletion.
    expect(cfg.lead_days).toBe(2)
    expect(cfg.window_days).toBe(5)
    expect(cfg.closed_weekdays).toEqual([0])
  })

  it('caps the allowlist length so a crafted body cannot bloat the row', () => {
    const many = consecutive(400)
    expect(fulfilmentConfig({ fulfilment: { mode: 'custom', custom_dates: many } }).custom_dates)
      .toHaveLength(MAX_CUSTOM_DATES)
  })

  it('reads needs_review as a real boolean only', () => {
    expect(fulfilmentConfig({ fulfilment: { needs_review: true } }).needs_review).toBe(true)
    expect(fulfilmentConfig({ fulfilment: { needs_review: 'yes' } }).needs_review).toBe(false)
  })
})

describe('selectableDates — custom mode', () => {
  it('offers exactly the ticked dates, ignoring lead, window and closed weekdays', () => {
    // 2026-07-26 is a Sunday, which closed_weekdays would remove in rolling mode.
    const cfg = custom(['2026-07-21', '2026-07-26', '2026-09-01'], {
      lead_days: 5, window_days: 1, closed_weekdays: [0, 1, 2, 3, 4, 5, 6],
    })
    expect(selectableDates(cfg, KL, NOON_MYT)).toEqual(['2026-07-21', '2026-07-26', '2026-09-01'])
  })

  it('offers today when today is ticked — ticked is ticked', () => {
    expect(selectableDates(custom(['2026-07-20']), KL, NOON_MYT)).toEqual(['2026-07-20'])
  })

  it('drops dates that have gone past on the SHOP clock', () => {
    expect(selectableDates(custom(['2026-07-19', '2026-07-21']), KL, NOON_MYT)).toEqual(['2026-07-21'])
  })

  it('drops dates beyond the 90-day horizon', () => {
    // 2026-07-20 + 90 days is 2026-10-18; 2026-10-19 is one past the last selectable day.
    expect(selectableDates(custom(['2026-10-18', '2026-10-19']), KL, NOON_MYT)).toEqual(['2026-10-18'])
  })

  it('offers nothing when every ticked date has passed', () => {
    expect(selectableDates(custom(['2026-07-01']), KL, NOON_MYT)).toEqual([])
  })
})

describe('needs_review pauses the shop on BOTH sides of the wire', () => {
  const paused = fulfilmentConfig({
    fulfilment: { mode: 'rolling', lead_days: 0, window_days: 14, needs_review: true },
  })

  it('offers no date at all, even though the rolling window is wide open', () => {
    expect(selectableDates(paused, KL, NOON_MYT)).toEqual([])
  })

  it('refuses the date the rolling window would otherwise allow', () => {
    expect(isDateSelectable('2026-07-21', paused, KL, NOON_MYT)).toBe(false)
  })

  it('pauses a custom shop too, whatever its dates say', () => {
    const cfg = custom(['2026-07-21'], { needs_review: true })
    expect(selectableDates(cfg, KL, NOON_MYT)).toEqual([])
    expect(isDateSelectable('2026-07-21', cfg, KL, NOON_MYT)).toBe(false)
  })
})

describe('isDateSelectable agrees with selectableDates in custom mode', () => {
  const cfg = custom(['2026-07-21', '2026-08-01'])

  it('accepts every date the list offers and refuses everything else', () => {
    for (const d of selectableDates(cfg, KL, NOON_MYT)) {
      expect(isDateSelectable(d, cfg, KL, NOON_MYT)).toBe(true)
    }
    expect(isDateSelectable('2026-07-22', cfg, KL, NOON_MYT)).toBe(false)
    expect(isDateSelectable('not-a-date', cfg, KL, NOON_MYT)).toBe(false)
  })
})

describe('customDateBounds', () => {
  it('runs from today on the shop clock to today + 90', () => {
    expect(customDateBounds(KL, NOON_MYT)).toEqual({ first: '2026-07-20', last: '2026-10-18' })
    expect(FULFILMENT_HORIZON_DAYS).toBe(90)
  })
})

describe('pruneCustomDates', () => {
  it('keeps today and the future, drops the past', () => {
    expect(pruneCustomDates(custom(['2026-07-01', '2026-07-20', '2026-08-01']), KL, NOON_MYT))
      .toEqual(['2026-07-20', '2026-08-01'])
  })
})

describe('validateCustomDates', () => {
  it('passes a normal list', () => {
    expect(validateCustomDates(['2026-07-21', '2026-08-01'], KL, NOON_MYT)).toBeNull()
  })

  it('refuses an empty list — a shop with no date cannot be ordered from', () => {
    expect(validateCustomDates([], KL, NOON_MYT)).toBe('no_dates')
  })

  it('refuses a past date and a date beyond the horizon by their own names', () => {
    expect(validateCustomDates(['2026-07-19'], KL, NOON_MYT)).toBe('past_date')
    expect(validateCustomDates(['2026-10-19'], KL, NOON_MYT)).toBe('beyond_horizon')
  })

  it('refuses more dates than the cap', () => {
    expect(validateCustomDates(consecutive(MAX_CUSTOM_DATES + 1), KL, NOON_MYT)).toBe('too_many')
  })
})

describe('fulfilmentWarning', () => {
  it('says nothing about a rolling shop — a window never runs dry', () => {
    expect(fulfilmentWarning(fulfilmentConfig({}), KL, NOON_MYT)).toEqual({ kind: 'none' })
  })

  it('reports the review first, whatever the dates say', () => {
    expect(fulfilmentWarning(custom(['2026-08-01'], { needs_review: true }), KL, NOON_MYT))
      .toEqual({ kind: 'review' })
  })

  it('reports empty when every ticked date has passed', () => {
    expect(fulfilmentWarning(custom(['2026-07-01']), KL, NOON_MYT)).toEqual({ kind: 'empty' })
  })

  it('reports ending when the last date is inside the warning window', () => {
    expect(fulfilmentWarning(custom(['2026-07-21', '2026-07-24']), KL, NOON_MYT))
      .toEqual({ kind: 'ending', last: '2026-07-24', daysLeft: 4 })
    expect(DATES_ENDING_SOON_DAYS).toBe(7)
  })

  it('says nothing while the last date is comfortably ahead', () => {
    expect(fulfilmentWarning(custom(['2026-09-01']), KL, NOON_MYT)).toEqual({ kind: 'none' })
  })
})

describe('isTimezone', () => {
  it('accepts real IANA zones', () => {
    expect(isTimezone(KL)).toBe(true)
    expect(isTimezone('UTC')).toBe(true)
  })

  it('refuses junk and non-strings', () => {
    expect(isTimezone('Not/AZone')).toBe(false)
    expect(isTimezone('')).toBe(false)
    expect(isTimezone(null)).toBe(false)
    expect(isTimezone(7)).toBe(false)
  })
})

describe('fulfilmentConfig — time slots', () => {
  it('reads a shop that predates slots as slots off, with default hours', () => {
    const cfg = fulfilmentConfig({ fulfilment: { mode: 'rolling' } })
    expect(cfg.slots_enabled).toBe(false)
    expect(cfg.slot_minutes).toBe(60)
    expect(cfg.slot_notice_minutes).toBe(0)
    expect(cfg.hours).toEqual(Array.from({ length: 7 }, () => ({ open: '09:00', close: '18:00' })))
  })

  it('reads slots_enabled as a real boolean only', () => {
    expect(fulfilmentConfig({ fulfilment: { slots_enabled: true } }).slots_enabled).toBe(true)
    expect(fulfilmentConfig({ fulfilment: { slots_enabled: 'true' } }).slots_enabled).toBe(false)
    expect(fulfilmentConfig({ fulfilment: { slots_enabled: 1 } }).slots_enabled).toBe(false)
  })

  it('reads hours per weekday and turns a junk day into closed without touching the others', () => {
    const hours = [
      null,
      { open: '10:00', close: '14:00' },
      { open: '14:00', close: '10:00' },   // close before open
      { open: '9:00', close: '18:00' },    // not HH:MM
      'lunch',
      { open: '08:30', close: '08:30' },   // zero length
      { open: '00:00', close: '23:30' },
    ]
    expect(fulfilmentConfig({ fulfilment: { hours } }).hours).toEqual([
      null,
      { open: '10:00', close: '14:00' },
      null,
      null,
      null,
      null,
      { open: '00:00', close: '23:30' },
    ])
  })

  it('reads a short hours array as closed on the days it does not name', () => {
    const cfg = fulfilmentConfig({ fulfilment: { hours: [{ open: '10:00', close: '12:00' }] } })
    expect(cfg.hours[0]).toEqual({ open: '10:00', close: '12:00' })
    expect(cfg.hours[1]).toBeNull()
    expect(cfg.hours).toHaveLength(7)
  })

  it('reads slot_minutes from the closed set only', () => {
    expect(fulfilmentConfig({ fulfilment: { slot_minutes: 30 } }).slot_minutes).toBe(30)
    expect(fulfilmentConfig({ fulfilment: { slot_minutes: 120 } }).slot_minutes).toBe(120)
    expect(fulfilmentConfig({ fulfilment: { slot_minutes: 45 } }).slot_minutes).toBe(60)
    expect(fulfilmentConfig({ fulfilment: { slot_minutes: '60' } }).slot_minutes).toBe(60)
  })

  it('clamps slot_notice_minutes to 0..1440', () => {
    expect(fulfilmentConfig({ fulfilment: { slot_notice_minutes: -5 } }).slot_notice_minutes).toBe(0)
    expect(fulfilmentConfig({ fulfilment: { slot_notice_minutes: 90.7 } }).slot_notice_minutes).toBe(90)
    expect(fulfilmentConfig({ fulfilment: { slot_notice_minutes: 99_999 } }).slot_notice_minutes).toBe(1440)
  })
})

describe('timeToMinutes / minutesToTime', () => {
  it('round-trips HH:MM', () => {
    expect(timeToMinutes('00:00')).toBe(0)
    expect(timeToMinutes('09:30')).toBe(570)
    expect(timeToMinutes('23:59')).toBe(1439)
    expect(minutesToTime(570)).toBe('09:30')
    expect(minutesToTime(0)).toBe('00:00')
  })

  it('refuses anything that is not a 24-hour HH:MM', () => {
    for (const v of ['24:00', '9:30', '09:60', '0930', '', null, 930, undefined]) {
      expect(timeToMinutes(v), String(v)).toBeNull()
    }
  })
})

// 2026-07-20 is a Monday. NOON_MYT is 12:00 in KL on that day.
const SLOTS: FulfilmentConfig = {
  ...DEFAULT_FULFILMENT,
  window_days: 3,
  slots_enabled: true,
  hours: [null, { open: '10:00', close: '14:00' }, { open: '10:00', close: '14:00' }, { open: '10:00', close: '14:00' }, null, null, null],
  slot_minutes: 60,
}

describe('minutesInZone', () => {
  it('reads the wall clock in the shop zone', () => {
    expect(minutesInZone(KL, NOON_MYT)).toBe(12 * 60)
    expect(minutesInZone('UTC', NOON_MYT)).toBe(4 * 60)
  })
  it('reads midnight as 0, never 1440', () => {
    expect(minutesInZone(KL, new Date('2026-07-19T16:00:00Z'))).toBe(0)
  })
})

describe('slotsBetween', () => {
  it('steps from open and drops the partial slot at the end', () => {
    expect(slotsBetween({ open: '10:00', close: '12:30' }, 60)).toEqual([
      { from: '10:00', to: '11:00' }, { from: '11:00', to: '12:00' },
    ])
    expect(slotsBetween({ open: '10:00', close: '12:30' }, 30)).toHaveLength(5)
    expect(slotsBetween({ open: '10:00', close: '11:59' }, 120)).toEqual([])
  })
})

describe('selectableSlots', () => {
  it('is empty while slots are off, whatever the hours say', () => {
    expect(selectableSlots('2026-07-21', { ...SLOTS, slots_enabled: false }, KL, NOON_MYT)).toEqual([])
  })

  it('offers every slot of a future open day', () => {
    expect(selectableSlots('2026-07-21', SLOTS, KL, NOON_MYT)).toEqual([
      { from: '10:00', to: '11:00' }, { from: '11:00', to: '12:00' },
      { from: '12:00', to: '13:00' }, { from: '13:00', to: '14:00' },
    ])
  })

  it('drops today’s slots that start before now + notice, and keeps one that starts exactly then', () => {
    expect(selectableSlots('2026-07-20', SLOTS, KL, NOON_MYT).map(s => s.from)).toEqual(['12:00', '13:00'])
    expect(selectableSlots('2026-07-20', { ...SLOTS, slot_notice_minutes: 60 }, KL, NOON_MYT).map(s => s.from)).toEqual(['13:00'])
    expect(selectableSlots('2026-07-20', { ...SLOTS, slot_notice_minutes: 61 }, KL, NOON_MYT)).toEqual([])
  })

  it('applies the notice across midnight — a day of notice at noon Monday hides Tuesday morning', () => {
    const cfg = { ...SLOTS, slot_notice_minutes: 1440 }
    expect(selectableSlots('2026-07-21', cfg, KL, NOON_MYT).map(s => s.from)).toEqual(['12:00', '13:00'])
  })

  it('is empty on a weekday with no hours, and on a date the date rule refuses', () => {
    expect(selectableSlots('2026-07-23', SLOTS, KL, NOON_MYT)).toEqual([])   // Thursday: null hours
    expect(selectableSlots('2026-07-30', SLOTS, KL, NOON_MYT)).toEqual([])   // past the 3-day window
    expect(selectableSlots('2026-07-21', { ...SLOTS, closed_weekdays: [2] }, KL, NOON_MYT)).toEqual([])
  })

  it('uses the shop clock, not UTC, to decide which day is today', () => {
    // LATE_MYT: 01:00 Tuesday in KL, still Monday in UTC. Tuesday 10:00 is 9h away — all four remain.
    expect(selectableSlots('2026-07-21', SLOTS, KL, LATE_MYT)).toHaveLength(4)
    // Monday is over on the shop clock: nothing.
    expect(selectableSlots('2026-07-20', SLOTS, KL, LATE_MYT)).toEqual([])
  })
})

describe('isSlotSelectable', () => {
  const at = (from: string, to: string) => isSlotSelectable('2026-07-21', { from, to }, SLOTS, KL, NOON_MYT)

  it('accepts a slot on the grid and refuses one off it', () => {
    expect(at('10:00', '11:00')).toBe(true)
    expect(at('13:00', '14:00')).toBe(true)
    expect(at('10:30', '11:30')).toBe(false)   // off the step grid
    expect(at('10:00', '11:30')).toBe(false)   // wrong length
    expect(at('14:00', '15:00')).toBe(false)   // past close
    expect(at('09:00', '10:00')).toBe(false)   // before open
    expect(at('11:00', '10:00')).toBe(false)   // inverted
    expect(at('10:00', '')).toBe(false)
  })

  it('refuses everything while slots are off', () => {
    expect(isSlotSelectable('2026-07-21', { from: '10:00', to: '11:00' }, { ...SLOTS, slots_enabled: false }, KL, NOON_MYT)).toBe(false)
  })

  it('agrees with selectableSlots over a sweep of dates, clocks and notices', () => {
    const clocks = [NOON_MYT, LATE_MYT, new Date('2026-07-20T01:59:00Z'), new Date('2026-07-20T05:00:00Z')]
    const notices = [0, 30, 90, 1440]
    const dates = ['2026-07-19', '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24']
    for (const now of clocks) for (const n of notices) for (const minutes of [30, 60, 120] as const) {
      const cfg = { ...SLOTS, slot_notice_minutes: n, slot_minutes: minutes }
      for (const date of dates) {
        const offered = selectableSlots(date, cfg, KL, now)
        const grid = slotsBetween({ open: '08:00', close: '16:00' }, minutes)
        for (const s of grid) {
          const listed = offered.some(o => o.from === s.from && o.to === s.to)
          expect(isSlotSelectable(date, s, cfg, KL, now), `${date} ${s.from} n=${n} m=${minutes} @${now.toISOString()}`).toBe(listed)
        }
      }
    }
  })
})

describe('the date rule when slots are on', () => {
  it('drops a date with no slot from selectableDates', () => {
    expect(selectableDates(SLOTS, KL, NOON_MYT)).toEqual(['2026-07-20', '2026-07-21', '2026-07-22'])
    // At 13:01 Monday nothing is left today: Monday drops.
    const late = new Date('2026-07-20T05:01:00Z')
    expect(selectableDates(SLOTS, KL, late)).toEqual(['2026-07-21', '2026-07-22'])
    expect(isDateSelectable('2026-07-20', SLOTS, KL, late)).toBe(false)
    expect(isDateSelectable('2026-07-21', SLOTS, KL, late)).toBe(true)
  })

  it('treats a weekday with null hours as closed in both modes', () => {
    const thursdayOnly = { ...SLOTS, window_days: 7 }
    expect(selectableDates(thursdayOnly, KL, NOON_MYT)).not.toContain('2026-07-23')
    const c = custom(['2026-07-21', '2026-07-23'], { slots_enabled: true, hours: SLOTS.hours })
    expect(selectableDates(c, KL, NOON_MYT)).toEqual(['2026-07-21'])
    expect(isDateSelectable('2026-07-23', c, KL, NOON_MYT)).toBe(false)
  })

  it('ignores hours entirely while slots are off', () => {
    const off = { ...SLOTS, slots_enabled: false }
    expect(selectableDates(off, KL, NOON_MYT)).toEqual(['2026-07-20', '2026-07-21', '2026-07-22'])
  })

  it('isDateSelectable still agrees with selectableDates', () => {
    for (const now of [NOON_MYT, LATE_MYT, new Date('2026-07-20T05:01:00Z')]) {
      const list = selectableDates(SLOTS, KL, now)
      for (const d of consecutive(10, Date.UTC(2026, 6, 18))) {
        expect(isDateSelectable(d, SLOTS, KL, now), `${d} @${now.toISOString()}`).toBe(list.includes(d))
      }
    }
  })
})

describe('validateSlotHours', () => {
  it('passes normal hours, and passes anything while slots are off', () => {
    expect(validateSlotHours(SLOTS.hours, SLOTS)).toBeNull()
    expect(validateSlotHours([{ open: '14:00', close: '10:00' }], { ...SLOTS, slots_enabled: false })).toBeNull()
  })

  it('names close_before_open on the RAW hours, which the reader would have hidden', () => {
    const raw = [null, { open: '14:00', close: '10:00' }]
    expect(validateSlotHours(raw, fulfilmentConfig({ fulfilment: { slots_enabled: true, hours: raw } }))).toBe('close_before_open')
    expect(validateSlotHours([{ open: '10:00', close: '10:00' }], SLOTS)).toBe('close_before_open')
  })

  it('names no_open_day when no weekday holds one full slot', () => {
    const cfg = { ...SLOTS, hours: [null, null, null, null, null, null, null] }
    expect(validateSlotHours(cfg.hours, cfg)).toBe('no_open_day')
    const short = { ...SLOTS, slot_minutes: 120 as const, hours: [{ open: '10:00', close: '11:00' }, null, null, null, null, null, null] }
    expect(validateSlotHours(short.hours, short)).toBe('no_open_day')
  })
})

describe('fulfilmentWarning — no_slots', () => {
  it('reports no_slots when slots are on and no offered date holds a slot', () => {
    const cfg = { ...SLOTS, hours: [null, null, null, null, null, null, null] }
    expect(fulfilmentWarning(cfg, KL, NOON_MYT)).toEqual({ kind: 'no_slots' })
  })

  it('says nothing for a rolling slot shop with an open day', () => {
    expect(fulfilmentWarning(SLOTS, KL, NOON_MYT)).toEqual({ kind: 'none' })
  })

  it('reports empty, not no_slots, when a custom allowlist has run dry', () => {
    const c = custom(['2026-07-01'], { slots_enabled: true, hours: SLOTS.hours })
    expect(fulfilmentWarning(c, KL, NOON_MYT)).toEqual({ kind: 'empty' })
  })

  it('still reports review first', () => {
    expect(fulfilmentWarning({ ...SLOTS, needs_review: true }, KL, NOON_MYT)).toEqual({ kind: 'review' })
  })
})
