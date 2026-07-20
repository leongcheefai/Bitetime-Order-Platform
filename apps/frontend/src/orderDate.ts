import type { Lang } from './types'

/**
 * The date an order was placed, as a customer reads it.
 *
 * One rule, because two customer-facing screens show the same fact: order history and the
 * track-order screen. They disagreed before this existed — history followed the language, track
 * was pinned to English — which is the kind of drift nobody notices until a Chinese customer sees
 * one screen in each language.
 */
export function formatOrderDate(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/**
 * A `YYYY-MM-DD` calendar date (e.g. `fulfil_date`), as the day it names — never the viewer's.
 *
 * `formatOrderDate` is for an INSTANT (`created_at`): it is correct to show an instant in
 * whatever zone the viewer happens to be in, because "when did this happen" is relative to
 * the reader. A calendar date is not an instant — it names a day on the shop's calendar,
 * independent of who is looking at it or from where. `new Date('2026-07-22')` parses as UTC
 * midnight, and formatting that without pinning the zone lets `toLocaleDateString` render it
 * as 21 Jul for a reader west of UTC or 22 Jul for a reader east of it — the same stored date
 * showing two different days depending on device timezone, which is exactly the kind of drift
 * this module's other comment warns about. Pinning `timeZone: 'UTC'` forces the formatter to
 * read the date back off the same UTC-midnight instant it was parsed into, so it always
 * renders the day the string names.
 */
export function formatCalendarDate(date: string | null | undefined, lang: Lang): string {
  if (!date) return ''
  const d = new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/**
 * The same fact, to the minute — what a receipt states and a list row does not.
 *
 * A sibling rather than an option on `formatOrderDate`, because that function's output is pinned
 * by two screens (order history and /track) that must keep showing a bare date.
 */
export function formatOrderDateTime(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
