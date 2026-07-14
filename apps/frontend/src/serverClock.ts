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
 * A failed sync leaves the offset at 0 — the device's own clock, i.e. the old behaviour. THIS ALONE
 * DOES NOT RECOVER (I-3, #69): if `GET /api/time` is persistently unreachable while `POST
 * /api/orders` still succeeds, `resync()` keeps failing, the offset stays 0, and a `price_changed`
 * retry that calls `resync()` again re-quotes against the same skewed clock and is refused again —
 * the exact permanent loop this module exists to prevent. Refetching the menu cannot repair a
 * clock; nothing in this file could either, on its own, because a device that cannot reach
 * `/api/time` has no way to hear the correct time from THIS endpoint.
 *
 * What actually closes the loop is `adopt()`: a backend that refuses an order with `price_changed`
 * hands back its own clock IN THE REFUSAL BODY (`app.ts`'s OrderError handler), over the same
 * connection that just proved it works. `refreshQuoteSources` (Storefront.tsx) feeds that
 * timestamp to `adopt()` instead of calling `resync()` again, so recovery needs no second
 * endpoint and — because it rides the response that already arrived — cannot fail the way a
 * fresh `/api/time` fetch can. `resync()` still exists for the ordinary case (`/api/time` reachable,
 * used at mount) and stays the fallback if a refusal ever lacks a `now`.
 */
export function useServerClock() {
  const [offset, setOffset] = useState(0)

  const resync = useCallback(async () => {
    const s = await fetchServerNow()
    if (s) setOffset(clockOffset(s.now, s.sentAt, s.receivedAt))
  }, [])

  /**
   * Adopt a server timestamp handed back BY A REFUSAL rather than by `/api/time` — no round
   * trip of its own, so it cannot add a second way for recovery to fail. There is no
   * `sentAt`/`receivedAt` pair to bracket this with (the timestamp arrived inside an error
   * body, not a dedicated clock request), so the offset is the plain difference against "now" —
   * within the round trip's own latency, which is what `price_changed` recovery needs, not
   * sub-second precision.
   */
  const adopt = useCallback((serverNowIso: string) => {
    const ms = Date.parse(serverNowIso)
    if (Number.isFinite(ms)) setOffset(ms - Date.now())
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

  return { now, resync, adopt }
}
