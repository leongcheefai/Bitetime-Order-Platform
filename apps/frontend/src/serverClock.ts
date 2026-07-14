import { useCallback, useEffect, useState } from 'react'
import { fetchServerNow } from './store'

/**
 * How far the SERVER's clock is ahead of ours, in ms.
 *
 * The midpoint of the two local timestamps is our best guess at what our clock read when the server
 * stamped its answer — charging the whole round trip to the offset would push us ahead of the server
 * by the network delay.
 */
export function clockOffset(serverNowMs: number, sentAt: number, receivedAt: number): number {
  return serverNowMs - (sentAt + receivedAt) / 2
}

/**
 * The clock the storefront prices with — the SERVER's, not the device's.
 *
 * Since #68 the browser quotes and the backend charges, and a disagreement is a hard refusal. The
 * promo window is the first rule that reads a clock, which makes the clock a PRICE INPUT: a device
 * minutes off ours, on the promo's last day, would quote the promo price, be refused, re-quote with
 * the same skewed clock, and be refused again — a permanent refusal loop for a legitimate customer,
 * on the busiest day of the promo. Refreshing the menu cannot fix a clock; only this can.
 *
 * A failed sync leaves the offset at 0 — the device's own clock, i.e. the old behaviour. The
 * storefront re-syncs on a `price_changed` recovery, and a backend that can refuse an order can
 * answer `/api/time`.
 */
export function useServerClock() {
  const [offset, setOffset] = useState(0)

  const resync = useCallback(async () => {
    const s = await fetchServerNow()
    if (s) setOffset(clockOffset(s.now, s.sentAt, s.receivedAt))
  }, [])

  // Mirrors usePlatformPricing's shape: the mount sync is inlined here rather than calling
  // `resync` by reference, because a bare `useEffect(() => { void resync() }, [resync])` trips
  // react-hooks' set-state-in-effect lint (calling a pre-defined setState-carrying callback from
  // an effect) — the fetch-then-setState-in-a-`.then` shape below is the same rule's blessed case.
  useEffect(() => {
    let active = true
    fetchServerNow().then((s) => {
      if (active && s) setOffset(clockOffset(s.now, s.sentAt, s.receivedAt))
    })
    return () => { active = false }
  }, [])

  // Depends on `offset` so a sync that lands after the first paint RE-PRICES. A ref here would
  // leave the promo quoted against the device's clock forever.
  const now = useCallback(() => new Date(Date.now() + offset), [offset])

  return { now, resync }
}
