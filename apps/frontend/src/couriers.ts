// Courier catalog: display name + public tracking-URL builder per courier code.
// The stored `orders.courier` holds one of these codes (or null). `other` covers
// couriers without a supported deep-link — the customer sees the AWB but no link.
//
// URL templates were checked against each courier's live site (2026-07-04):
// - jnt: confirmed — jtexpress.my's tracking page is path-based (`/tracking/<awb>`),
//   not the `gzquery.html?bills=` form from the original draft (that path 404s).
// - poslaju: the tracking app actually lives on `tracking.pos.com.my` (the
//   `track.pos.com.my` domain in the original draft does not resolve). The app is
//   an Angular SPA; the `trackingNo` query param could not be confirmed without
//   executing its JS, so it is best-effort.
// - ninja: confirmed — matches Ninja Van's own "Enter your Tracking ID" copy.
// - citylink: confirmed — the site's own tracking-result redirect script builds
//   `track0=<value>` (not `track=`) for a single tracking number.
// - spx: best-effort — Shopee's SPX tracking page is a React SPA; the query
//   param could not be confirmed without executing its JS.
// - flash: best-effort — flashexpress.my returned HTTP 502 and flashexpress.com
//   is behind a bot-check wall during verification, so the `se` param is unconfirmed.
export interface Courier {
  code: string
  name: string
  track: ((awb: string) => string) | null
}

export const COURIERS: Courier[] = [
  { code: 'jnt',      name: 'J&T Express',    track: (awb) => `https://www.jtexpress.my/tracking/${encodeURIComponent(awb)}` },
  { code: 'poslaju',  name: 'Pos Laju',       track: (awb) => `https://tracking.pos.com.my/tracking?trackingNo=${encodeURIComponent(awb)}` },
  { code: 'ninja',    name: 'Ninja Van',      track: (awb) => `https://www.ninjavan.co/en-my/tracking?id=${encodeURIComponent(awb)}` },
  { code: 'citylink', name: 'City-Link',      track: (awb) => `https://www.citylinkexpress.com/tracking-result/?track0=${encodeURIComponent(awb)}` },
  { code: 'spx',      name: 'Shopee Express', track: (awb) => `https://spx.com.my/track?tracking_number=${encodeURIComponent(awb)}` },
  { code: 'flash',    name: 'Flash Express',  track: (awb) => `https://www.flashexpress.my/fle/tracking?se=${encodeURIComponent(awb)}` },
  { code: 'other',    name: 'Other',          track: null },
]

const BY_CODE = new Map(COURIERS.map(c => [c.code, c]))

export function courierName(code: string | null | undefined): string {
  if (!code) return ''
  return BY_CODE.get(code)?.name ?? ''
}

export function trackingUrl(code: string | null | undefined, awb: string | null | undefined): string | null {
  if (!code || !awb || !awb.trim()) return null
  const courier = BY_CODE.get(code)
  if (!courier || !courier.track) return null
  return courier.track(awb.trim())
}
