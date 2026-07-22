// Address autocomplete, through the backend proxy. No Maps key is ever present in this bundle —
// that is the point of the proxy (#101, story 49).
import { API_URL } from './api'

export interface PlaceSuggestion { placeId: string; text: string }

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
 * A session token groups a burst of keystrokes and the details call that ends them into ONE
 * billable lookup. Mint one when the field is focused, pass the same one to every suggest call
 * AND to the details call, then throw it away — a reused token bills as a second session.
 */
export function newPlaceSession(): string {
  return crypto.randomUUID()
}

/** Never throws: a dead autocomplete degrades to "no suggestions", not a broken checkout. */
export async function suggestPlaces(input: string, session: string): Promise<PlaceSuggestion[]> {
  try {
    const res = await fetch(`${API_URL}/api/places/suggest?input=${encodeURIComponent(input)}&session=${encodeURIComponent(session)}`)
    if (!res.ok) return []
    return ((await res.json()) as { suggestions?: PlaceSuggestion[] }).suggestions ?? []
  } catch {
    return []
  }
}

/** `null` when the place could not be read — the caller must not fabricate an address from it. */
export async function placeDetail(placeId: string, session: string): Promise<PlaceDetail | null> {
  try {
    const res = await fetch(`${API_URL}/api/places/detail/${encodeURIComponent(placeId)}?session=${encodeURIComponent(session)}`)
    if (!res.ok) return null
    return (await res.json()) as PlaceDetail
  } catch {
    return null
  }
}
