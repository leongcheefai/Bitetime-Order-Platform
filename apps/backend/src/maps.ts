// The ONE place in this codebase that talks to Google Maps Platform.
//
// Everything here is an ADAPTER: I/O with no policy in it. The cache, the 30-day expiry, the
// out-of-range rule and the fee arithmetic all live elsewhere (distance.ts, @bitetime/shared)
// precisely so they can be tested without a network. Shaped like `telegramSend` in notify.ts,
// and injected the same way.
//
// The key is the PLATFORM's and never reaches the browser — the autocomplete and details calls
// are proxied through app.ts for exactly that reason (#101, story 49).
import { env } from './env.js'

/**
 * Three outcomes, and callers MUST tell them apart:
 *   * `ok`       — a road distance.
 *   * `no_route` — an answer about the world: there is no road route between these two points.
 *                  Not an error, and never worth retrying.
 *   * `failed`   — the lookup itself did not happen (no key, network, 5xx, quota). Retryable,
 *                  and the ONLY outcome that tells a customer to try again.
 */
export type RouteOutcome =
  | { status: 'ok'; metres: number }
  | { status: 'no_route' }
  | { status: 'failed' }

export type RouteLookup = (originPlaceId: string, destinationPlaceId: string) => Promise<RouteOutcome>

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes'

/**
 * Routes API v2. `TRAFFIC_UNAWARE` on purpose: a fee must not change because the customer
 * quoted at 6pm and submitted at 6:05 — that is the permanent `price_changed` loop the ADR
 * rejected a second live call to avoid.
 *
 * The field mask is the billing surface: asking only for `routes.distanceMeters` keeps this on
 * the cheapest SKU. Do not widen it without meaning to.
 *
 * Google answers a routable-but-unreachable pair with HTTP 200 and an EMPTY `routes` array —
 * which is `no_route`, not `failed`. Collapsing the two would tell a customer in Sabah to keep
 * retrying a route to Kuala Lumpur that will never exist.
 */
export const googleRouteLookup: RouteLookup = async (originPlaceId, destinationPlaceId) => {
  if (!env.googleMapsApiKey) {
    console.error('Route lookup skipped: GOOGLE_MAPS_API_KEY is not set')
    return { status: 'failed' }
  }
  try {
    const res = await fetch(ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': env.googleMapsApiKey,
        'X-Goog-FieldMask': 'routes.distanceMeters',
      },
      body: JSON.stringify({
        origin: { placeId: originPlaceId },
        destination: { placeId: destinationPlaceId },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_UNAWARE',
      }),
    })
    if (!res.ok) {
      console.error(`Route lookup failed: ${res.status}`)
      return { status: 'failed' }
    }
    const body = (await res.json()) as { routes?: { distanceMeters?: number }[] }

    // An EMPTY or absent `routes` array is Google's documented answer for "there is no road
    // route between these two points" — an answer about the world, and a permanent refusal.
    if (!body.routes?.length) return { status: 'no_route' }

    // A route that came back WITHOUT a usable distance is a different thing entirely: we did
    // not understand the response. It must fail RETRYABLE, not permanent. `no_route` tells the
    // customer this shop does not deliver to their address and pointedly does not invite them to
    // try again — so a response-shape drift classified that way would present a total outage as
    // a business rule, at every address, with nothing on screen to say anything was broken.
    const metres = body.routes[0]?.distanceMeters
    if (typeof metres !== 'number' || !Number.isFinite(metres)) {
      console.error('Route lookup returned a route with no usable distanceMeters')
      return { status: 'failed' }
    }
    return { status: 'ok', metres }
  } catch (err) {
    console.error('Route lookup threw:', err instanceof Error ? err.message : String(err))
    return { status: 'failed' }
  }
}

export interface PlaceSuggestion {
  placeId: string
  /** What the customer reads in the dropdown. */
  text: string
}

const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete'

/**
 * Places (New) Autocomplete, proxied.
 *
 * `sessionToken` is money, not hygiene: a burst of keystrokes carrying one token bills as ONE
 * lookup when it ends in a details call. The caller mints it and passes the same one through to
 * `googlePlaceDetail`.
 *
 * Failure returns an EMPTY LIST rather than throwing: a dead autocomplete must degrade to "no
 * suggestions", never to a broken checkout screen.
 */
export async function googlePlaceSuggest(input: string, sessionToken: string): Promise<PlaceSuggestion[]> {
  if (!env.googleMapsApiKey || !input.trim()) return []
  try {
    const res = await fetch(AUTOCOMPLETE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': env.googleMapsApiKey },
      body: JSON.stringify({
        input,
        sessionToken,
        includedRegionCodes: ['my'],
      }),
    })
    if (!res.ok) {
      console.error(`Place autocomplete failed: ${res.status}`)
      return []
    }
    const body = (await res.json()) as {
      suggestions?: { placePrediction?: { placeId?: string; text?: { text?: string } } }[]
    }
    return (body.suggestions ?? [])
      .map(s => s.placePrediction)
      .filter((p): p is { placeId: string; text: { text: string } } => !!p?.placeId && !!p?.text?.text)
      .map(p => ({ placeId: p.placeId, text: p.text.text }))
  } catch (err) {
    console.error('Place autocomplete threw:', err instanceof Error ? err.message : String(err))
    return []
  }
}

export interface PlaceDetail {
  placeId: string
  formatted: string
  lat: number
  lng: number
  postcode: string
  city: string
  state: string
}

/**
 * Places (New) Details. Returns the printable address parts alongside the coordinates, so the
 * customer never types a postcode, city or state that the selected place already knows.
 *
 * The field mask is again the billing surface — `addressComponents` is what keeps this off the
 * most expensive SKU while still filling the form.
 */
export async function googlePlaceDetail(placeId: string, sessionToken: string): Promise<PlaceDetail | null> {
  if (!env.googleMapsApiKey || !placeId) return null
  try {
    const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?sessionToken=${encodeURIComponent(sessionToken)}`
    const res = await fetch(url, {
      headers: {
        'X-Goog-Api-Key': env.googleMapsApiKey,
        'X-Goog-FieldMask': 'id,formattedAddress,location,addressComponents',
      },
    })
    if (!res.ok) {
      console.error(`Place details failed: ${res.status}`)
      return null
    }
    const body = (await res.json()) as {
      id?: string
      formattedAddress?: string
      location?: { latitude?: number; longitude?: number }
      addressComponents?: { longText?: string; shortText?: string; types?: string[] }[]
    }
    const lat = body.location?.latitude
    const lng = body.location?.longitude
    if (!body.id || typeof lat !== 'number' || typeof lng !== 'number') return null

    const part = (type: string) =>
      body.addressComponents?.find(c => c.types?.includes(type))?.longText ?? ''

    return {
      placeId: body.id,
      formatted: body.formattedAddress ?? '',
      lat,
      lng,
      postcode: part('postal_code'),
      // `locality` is the city for most Malaysian addresses; some rural ones only carry the
      // administrative level below the state. Falling back beats handing back a blank field the
      // customer then has to fill in themselves.
      city: part('locality') || part('administrative_area_level_2'),
      state: part('administrative_area_level_1'),
    }
  } catch (err) {
    console.error('Place details threw:', err instanceof Error ? err.message : String(err))
    return null
  }
}
