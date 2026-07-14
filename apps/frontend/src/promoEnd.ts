/**
 * The merchant picks a DATE; the column stores an INSTANT.
 *
 * The instant is the end of that day in the timezone of the browser that set it. That is a real
 * limitation, and it is the honest one available: the shop has no timezone of its own (that is
 * separate work). What it buys is that the promo's end is an absolute instant on the wire, so the
 * customer's browser and the server cannot resolve it eight hours apart — which is exactly what
 * `new Date(dateString + 'T23:59:59')` did, because that parses as LOCAL time on both sides.
 */
export function promoEndFromDate(date: string): string | null {
  if (!date) return null
  const [y, m, d] = date.split('-').map(Number)
  if (!y || !m || !d) return null
  const end = new Date(y, m - 1, d, 23, 59, 59, 999)   // local end-of-day
  return Number.isNaN(end.getTime()) ? null : end.toISOString()
}

/** The inverse, for the dashboard's `<input type="date">`. */
export function promoEndToDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
