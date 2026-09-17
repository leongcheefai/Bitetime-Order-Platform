// When a customer may ask for their order — the rule the storefront picker is BUILT from and
// the rule order intake CHECKS against. It is here, and not in either app, for the same reason
// pricing.ts is: the browser quotes a date and the backend refuses one, and two copies of this
// arithmetic that drift by a day are a checkout that refuses every honest order on the window's
// edge, with nothing on screen to explain it.

/** Which rule decides the dates a shop offers. Closed set — see CONTEXT.md → Fulfilment date. */
export type FulfilmentMode = 'rolling' | 'custom'

/** The slot lengths a shop may pick. Closed set — the form offers exactly these. */
export type SlotMinutes = 30 | 60 | 120
export const SLOT_MINUTES: readonly SlotMinutes[] = [30, 60, 120]

/** The longest notice a shop may ask for: one day. Beyond that, `lead_days` is the tool. */
export const SLOT_NOTICE_MAX = 1440

/** One weekday's opening hours, `HH:MM` 24-hour, shop-local. `close` is after `open`. */
export interface DayHours { open: string; close: string }

/** One window a customer may pick, `HH:MM` both ends, `to` = `from` + `slot_minutes`. */
export interface Slot { from: string; to: string }

/** Per-merchant shape, stored under `merchants.config -> 'fulfilment'`. */
export interface FulfilmentConfig {
  /** `rolling` computes a moving range; `custom` offers an explicit allowlist and nothing else. */
  mode: FulfilmentMode
  /** Days before the first date a customer may pick. 0 allows same-day. ROLLING ONLY. */
  lead_days: number
  /** How many dates are offered, counted from the first selectable one. ROLLING ONLY. */
  window_days: number
  /** Weekdays the shop takes nothing, 0 = Sunday … 6 = Saturday. ROLLING ONLY. */
  closed_weekdays: number[]
  /** The dates a `custom` shop offers, `YYYY-MM-DD`, sorted and deduped. CUSTOM ONLY. */
  custom_dates: string[]
  /**
   * The shop is PAUSED until its owner confirms its dates in the Fulfilment tab. It is checked
   * here, in the rule both sides of the wire share, rather than in the storefront — a pause the
   * backend does not honour is a pause a scripted POST walks straight through. While it is set,
   * `offerableDates` answers empty and the storefront refuses every order.
   *
   * NOTHING WRITES IT ANY MORE. It was set when a shop lost custom dates by stepping down from
   * Pro (ADR 0015), and there is no step down (#222). The flag and its readers survive so a row
   * written before that still behaves as its owner was told it would, and so the Fulfilment tab's
   * Confirm control can still clear it.
   */
  needs_review: boolean
  /**
   * The customer picks a TIME SLOT after the date (#282). Off for every shop until its owner turns
   * it on, so the day this shipped changed nothing for anyone. While off, `hours`, `slot_minutes`
   * and `slot_notice_minutes` are dormant — kept in the row like an unused mode's settings.
   */
  slots_enabled: boolean
  /** Opening hours per weekday, index 0 = Sunday … 6 = Saturday. `null` = closed that day. */
  hours: (DayHours | null)[]
  /** How long one slot is. */
  slot_minutes: SlotMinutes
  /** A slot must START at least this many minutes after now, on the shop's clock. */
  slot_notice_minutes: number
}

/**
 * What a shop that has never opened the Fulfilment tab offers: today through two weeks out,
 * closed on no day. Every existing merchant reads as this, so the feature works on day one
 * without a single merchant touching their settings.
 */
export const DEFAULT_HOURS: readonly (DayHours | null)[] =
  Array.from({ length: 7 }, () => ({ open: '09:00', close: '18:00' }))

export const DEFAULT_FULFILMENT: FulfilmentConfig = {
  mode: 'rolling',
  lead_days: 0,
  window_days: 14,
  closed_weekdays: [],
  custom_dates: [],
  needs_review: false,
  slots_enabled: false,
  hours: DEFAULT_HOURS.map(h => (h ? { ...h } : null)),
  slot_minutes: 60,
  slot_notice_minutes: 0,
}

export const DEFAULT_TIMEZONE = 'Asia/Kuala_Lumpur'

const LEAD_MAX = 30

/**
 * How far ahead a shop may commit, and it is ONE horizon for both modes — `window_days` is
 * clamped to it and a ticked date beyond it is never offered. The feedback asked for "three
 * months"; this is that, in the day-count arithmetic this module is already built from.
 */
export const FULFILMENT_HORIZON_DAYS = 90

/** today … today+90 inclusive is 91 days, so no honest allowlist can be longer. */
export const MAX_CUSTOM_DATES = 91

/** How close the last remaining date gets before the dashboard says so. */
export const DATES_ENDING_SOON_DAYS = 7

/** True for a string Intl will actually accept as a time zone. */
export function isTimezone(tz: unknown): boolean {
  if (typeof tz !== 'string' || tz === '') return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.min(hi, Math.max(lo, Math.trunc(v)))
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** `HH:MM` (24-hour) as minutes since midnight, or null for anything else. */
export function timeToMinutes(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const m = TIME_RE.exec(v)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

export function minutesToTime(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}

/** One weekday's hours off the raw bag. Anything that is not a real, non-empty range reads as closed. */
function dayHours(raw: unknown): DayHours | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const open = timeToMinutes(r.open)
  const close = timeToMinutes(r.close)
  if (open === null || close === null || close <= open) return null
  return { open: r.open as string, close: r.close as string }
}

/**
 * Seven days of hours off the raw bag. A MISSING key reads as the default week: the merchant
 * never opened the card. A PRESENT array reads day by day, and a day the array does not name is
 * closed — the merchant sent a list, and a day they did not send is a day they did not open.
 */
function hoursFromRaw(raw: unknown): (DayHours | null)[] {
  if (raw === undefined) return DEFAULT_HOURS.map(h => (h ? { ...h } : null))
  const src = Array.isArray(raw) ? raw : []
  return Array.from({ length: 7 }, (_, i) => dayHours(src[i]))
}

/**
 * Read a merchant's fulfilment rules off the raw `config` jsonb.
 *
 * The sibling of `shopRates`: one function READS this bag on both sides of the wire, so the
 * settings form writes through it too and cannot save a row the storefront then reads back
 * differently. Falls back PER FIELD — one junk value must not discard the merchant's other
 * two, which would silently re-open a shop on the day it said it was closed.
 */
export function fulfilmentConfig(raw: unknown): FulfilmentConfig {
  const bag = (raw ?? {}) as Record<string, unknown>
  const f = (bag.fulfilment ?? {}) as Record<string, unknown>
  if (typeof f !== 'object' || f === null) return { ...DEFAULT_FULFILMENT }
  const closed = Array.isArray(f.closed_weekdays) ? f.closed_weekdays : []
  const dates = Array.isArray(f.custom_dates) ? f.custom_dates : []
  return {
    // Anything that is not the one known alternative reads as rolling: every shop predating this
    // feature, and any future value this build has never heard of. Never a throw — a config that
    // cannot be parsed must not take checkout down.
    mode: f.mode === 'custom' ? 'custom' : 'rolling',
    lead_days: clampInt(f.lead_days, 0, LEAD_MAX, DEFAULT_FULFILMENT.lead_days),
    window_days: clampInt(f.window_days, 1, FULFILMENT_HORIZON_DAYS, DEFAULT_FULFILMENT.window_days),
    closed_weekdays: [...new Set(
      closed.filter((d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6),
    )].sort((a, b) => a - b),
    // Structural only: real calendar dates, deduped, sorted, length-capped. The 90-day HORIZON is
    // not applied here because it needs a clock and this function deliberately has none — it is
    // enforced by `selectableDates` (which never offers a date past it) and `validateCustomDates`
    // (which refuses to save one).
    custom_dates: [...new Set(
      dates.filter((d): d is string => typeof d === 'string' && dayMs(d) !== null),
    )].sort().slice(0, MAX_CUSTOM_DATES),
    needs_review: f.needs_review === true,
    slots_enabled: f.slots_enabled === true,
    hours: hoursFromRaw(f.hours),
    slot_minutes: (SLOT_MINUTES as readonly number[]).includes(f.slot_minutes as number)
      ? (f.slot_minutes as SlotMinutes)
      : DEFAULT_FULFILMENT.slot_minutes,
    slot_notice_minutes: clampInt(f.slot_notice_minutes, 0, SLOT_NOTICE_MAX, DEFAULT_FULFILMENT.slot_notice_minutes),
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function formatUTCDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/**
 * A calendar date as UTC midnight milliseconds — the ONLY place a date string becomes a number.
 *
 * UTC deliberately: it has no daylight saving, so "+1 day" is always +86400000 and a window can
 * never gain or lose an hour and land on the wrong date. Returns null for anything that is not a
 * real calendar date, INCLUDING dates that round-trip wrong (2026-02-30 is not February 30th, it
 * is March 2nd, and accepting it would sell an order on a day the customer never picked).
 */
function dayMs(date: string): number | null {
  if (!DATE_RE.test(date)) return null
  const ms = Date.parse(`${date}T00:00:00Z`)
  if (Number.isNaN(ms)) return null
  const d = new Date(ms)
  const round = formatUTCDate(d)
  return round === date ? ms : null
}

const DAY = 86_400_000

function fromDayMs(ms: number): string {
  const d = new Date(ms)
  return formatUTCDate(d)
}

/**
 * Today's date on the SHOP's clock.
 *
 * Not the customer's: a customer ordering from another timezone must see the same earliest date
 * the merchant would, or the lead time silently means something different for them. An invalid
 * zone falls back rather than throwing — a bad `merchants.timezone` row must not take checkout
 * down, and the default is the only shop clock this platform has ever had.
 */
export function todayInZone(tz: string, now: Date): string {
  const zone = isTimezone(tz) ? tz : DEFAULT_TIMEZONE
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** The window's bounds as UTC-midnight ms, or null if the shop clock cannot be read. */
function windowBounds(cfg: FulfilmentConfig, tz: string, now: Date): { first: number; last: number } | null {
  const today = dayMs(todayInZone(tz, now))
  if (today === null) return null
  const first = today + cfg.lead_days * DAY
  return { first, last: first + (cfg.window_days - 1) * DAY }
}

/** The allowlist's bounds as UTC-midnight ms, or null if the shop clock cannot be read. */
function customBoundsMs(tz: string, now: Date): { first: number; last: number } | null {
  const today = dayMs(todayInZone(tz, now))
  if (today === null) return null
  return { first: today, last: today + FULFILMENT_HORIZON_DAYS * DAY }
}

/** The first and last date a merchant may TICK, for the calendar's own bounds. */
export function customDateBounds(tz: string, now: Date): { first: string; last: string } | null {
  const b = customBoundsMs(tz, now)
  return b ? { first: fromDayMs(b.first), last: fromDayMs(b.last) } : null
}

/**
 * Every date this shop is currently taking orders for, in order. What the picker renders.
 *
 * `needs_review` short-circuits both modes: a shop awaiting its owner's confirmation offers
 * nothing at all. That check lives HERE, not in the storefront, so order intake refuses the same
 * dates the picker declines to draw (ADR 0015).
 *
 * In `rolling`, closed weekdays are REMOVED from the window, they do not extend it: `window_days`
 * is how far ahead the merchant is willing to commit, not a quota of open days. A shop closed
 * every day returns an empty list, which the settings form is what prevents — the rule here
 * reports the merchant's configuration honestly rather than quietly re-opening a day.
 *
 * In `custom`, lead days, the window and closed weekdays do not apply at all: the merchant named
 * the dates, and honouring their own notice period is theirs to do by not ticking tomorrow.
 */
export function selectableDates(cfg: FulfilmentConfig, tz: string, now: Date): string[] {
  if (cfg.needs_review) return []
  if (cfg.mode === 'custom') {
    const b = customBoundsMs(tz, now)
    if (!b) return []
    // Already sorted and deduped by `fulfilmentConfig`, so this preserves order for free.
    return cfg.custom_dates.filter(d => {
      const ms = dayMs(d)
      return ms !== null && ms >= b.first && ms <= b.last
    })
  }
  const b = windowBounds(cfg, tz, now)
  if (!b) return []
  const out: string[] = []
  for (let ms = b.first; ms <= b.last; ms += DAY) {
    if (!cfg.closed_weekdays.includes(new Date(ms).getUTCDay())) out.push(fromDayMs(ms))
  }
  return out
}

/**
 * May this shop take an order for this date, right now?
 *
 * The intake check. It is deliberately a predicate over one date rather than a lookup in
 * `selectableDates`, because intake gets a date from a request body and must judge it without
 * building a list — but the two MUST agree, and a test pins that they do.
 */
export function isDateSelectable(date: string, cfg: FulfilmentConfig, tz: string, now: Date): boolean {
  const ms = dayMs(date)
  if (ms === null) return false
  if (cfg.needs_review) return false
  if (cfg.mode === 'custom') {
    const b = customBoundsMs(tz, now)
    if (!b) return false
    return ms >= b.first && ms <= b.last && cfg.custom_dates.includes(date)
  }
  const b = windowBounds(cfg, tz, now)
  if (!b) return false
  if (ms < b.first || ms > b.last) return false
  return !cfg.closed_weekdays.includes(new Date(ms).getUTCDay())
}

/** Drop the dates that have gone past. Called on SAVE, never on read — see ADR 0015. */
export function pruneCustomDates(cfg: FulfilmentConfig, tz: string, now: Date): string[] {
  const today = dayMs(todayInZone(tz, now))
  if (today === null) return cfg.custom_dates
  return cfg.custom_dates.filter(d => {
    const ms = dayMs(d)
    return ms !== null && ms >= today
  })
}

export type CustomDatesError = 'no_dates' | 'past_date' | 'beyond_horizon' | 'too_many'

/**
 * Why this allowlist cannot be saved, or null.
 *
 * `no_dates` is the twin of the all-seven-days-closed refusal: it stops the merchant walking into
 * the paused state from the form itself, so only time or billing can put them there.
 */
export function validateCustomDates(dates: string[], tz: string, now: Date): CustomDatesError | null {
  if (dates.length === 0) return 'no_dates'
  if (dates.length > MAX_CUSTOM_DATES) return 'too_many'
  const b = customBoundsMs(tz, now)
  if (!b) return null
  for (const d of dates) {
    const ms = dayMs(d)
    if (ms === null || ms < b.first) return 'past_date'
    if (ms > b.last) return 'beyond_horizon'
  }
  return null
}

export type FulfilmentWarning =
  | { kind: 'none' }
  | { kind: 'review' }
  | { kind: 'empty' }
  | { kind: 'ending'; last: string; daysLeft: number }

/**
 * What the merchant dashboard needs to say about this shop's dates.
 *
 * A rolling shop is never warned: a moving window cannot run dry. A custom shop can, which is the
 * whole reason this exists — the merchant who ticked three dates in August must hear about it in
 * July, not from a customer in September.
 */
export function fulfilmentWarning(cfg: FulfilmentConfig, tz: string, now: Date): FulfilmentWarning {
  if (cfg.needs_review) return { kind: 'review' }
  if (cfg.mode !== 'custom') return { kind: 'none' }
  const open = selectableDates(cfg, tz, now)
  if (open.length === 0) return { kind: 'empty' }
  const today = dayMs(todayInZone(tz, now))
  const last = open[open.length - 1]
  const lastMs = dayMs(last)
  if (today === null || lastMs === null) return { kind: 'none' }
  const daysLeft = Math.round((lastMs - today) / DAY)
  return daysLeft <= DATES_ENDING_SOON_DAYS ? { kind: 'ending', last, daysLeft } : { kind: 'none' }
}

