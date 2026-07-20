// When a customer may ask for their order — the rule the storefront picker is BUILT from and
// the rule order intake CHECKS against. It is here, and not in either app, for the same reason
// pricing.ts is: the browser quotes a date and the backend refuses one, and two copies of this
// arithmetic that drift by a day are a checkout that refuses every honest order on the window's
// edge, with nothing on screen to explain it.

/** Per-merchant shape, stored under `merchants.config -> 'fulfilment'`. */
export interface FulfilmentConfig {
  /** Days before the first date a customer may pick. 0 allows same-day. */
  lead_days: number
  /** How many dates are offered, counted from the first selectable one. */
  window_days: number
  /** Weekdays the shop takes nothing, 0 = Sunday … 6 = Saturday. */
  closed_weekdays: number[]
}

/**
 * What a shop that has never opened the Fulfilment tab offers: today through two weeks out,
 * closed on no day. Every existing merchant reads as this, so the feature works on day one
 * without a single merchant touching their settings.
 */
export const DEFAULT_FULFILMENT: FulfilmentConfig = { lead_days: 0, window_days: 14, closed_weekdays: [] }

export const DEFAULT_TIMEZONE = 'Asia/Kuala_Lumpur'

const LEAD_MAX = 30
const WINDOW_MAX = 90

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
  return {
    lead_days: clampInt(f.lead_days, 0, LEAD_MAX, DEFAULT_FULFILMENT.lead_days),
    window_days: clampInt(f.window_days, 1, WINDOW_MAX, DEFAULT_FULFILMENT.window_days),
    closed_weekdays: [...new Set(
      closed.filter((d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6),
    )].sort((a, b) => a - b),
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

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
  const round = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  return round === date ? ms : null
}

const DAY = 86_400_000

function fromDayMs(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
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

/**
 * Every date this shop is currently taking orders for, in order. What the picker renders.
 *
 * Closed weekdays are REMOVED from the window, they do not extend it: `window_days` is how far
 * ahead the merchant is willing to commit, not a quota of open days. A shop closed every day
 * returns an empty list, which the settings form is what prevents (see Task 5) — the rule here
 * reports the merchant's configuration honestly rather than quietly re-opening a day.
 */
export function selectableDates(cfg: FulfilmentConfig, tz: string, now: Date): string[] {
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
  const b = windowBounds(cfg, tz, now)
  if (!b) return false
  if (ms < b.first || ms > b.last) return false
  return !cfg.closed_weekdays.includes(new Date(ms).getUTCDay())
}
