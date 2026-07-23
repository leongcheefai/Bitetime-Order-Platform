import type { AddressParts, Profile } from './types'

/**
 * What a signed-in customer's order teaches their profile, and what their profile hands back to
 * the next order's form. The two halves of "type it once, ever".
 *
 * Saved silently — there is no "save this address?" checkbox. It is the customer's own address,
 * the most recent one is almost always the right default, and a checkbox on an already-long form
 * buys nothing but a decision.
 */

/**
 * Deliberately no `name`. The checkout field is the name for *this order* — a customer ordering
 * lunch for a colleague types the colleague's — and `profiles.name` is the name on their ACCOUNT,
 * the same column the merchant's own row uses. Writing one into the other would let a recipient's
 * name silently rename the account. The name is prefilled from the profile; it never writes back.
 */
export interface SavedDetails {
  whatsapp?: string
  delivery_address?: AddressParts
}

/**
 * "Complete enough to remember" on either of TWO grounds, because the two delivery paths
 * remember an address for different reasons (#101 review, Finding 4):
 *
 *   - the REGION path has no place id, so all four parts are demanded — that address is
 *     remembered because it can be PRINTED, and a printed address missing a part is useless to
 *     the merchant reading it.
 *   - the DISTANCE path has a confirmed `place_id`, so `line1` plus the id is enough — that
 *     address is remembered because it can be ROUTED, and Google returns no `postal_code`
 *     component for plenty of real, deliverable places (POIs, rural addresses). The distance
 *     form has no field to fill that gap with, and demanding one anyway meant a picked,
 *     routable address was silently never saved — the "once ever" prefill (Finding 3) could
 *     never even start for it.
 */
function isCompleteAddress(a: AddressParts | undefined | null): a is AddressParts {
  if (!a) return false
  if (a.place_id) return typeof a.line1 === 'string' && a.line1.trim() !== ''
  return [a.line1, a.postcode, a.city, a.state].every(part => typeof part === 'string' && part.trim() !== '')
}

/**
 * The shape the form works in. `delivery_address` is jsonb and will hold whatever it was last
 * given — including a DISTANCE-path save, where `postcode`/`city`/`state` can be present but
 * BLANK (see `isCompleteAddress` above). This only checks the four fields are STRINGS, not that
 * they are non-blank, so such a row still passes and prefills correctly; `place_id`, present or
 * absent, is never inspected here and rides along unchanged in the object this returns, so a
 * saved address with one is still recognised — and still routable — on the way back in.
 */
function isAddressShaped(a: unknown): a is AddressParts {
  if (!a || typeof a !== 'object') return false
  const parts = a as Record<string, unknown>
  return ['line1', 'postcode', 'city', 'state'].every(k => typeof parts[k] === 'string')
}

export function savedDetailsFromOrder(order: {
  mode: 'pickup' | 'delivery' | 'express'
  wa: string
  address: AddressParts
}): SavedDetails {
  const saved: SavedDetails = {}
  const whatsapp = order.wa.trim()
  if (whatsapp) saved.whatsapp = whatsapp
  // A pickup order carries no address. Writing the form's empty one would blank the address the
  // customer saved on their last delivery — and they would only discover it at the next
  // checkout. The test is "not a pickup", not "is a delivery": an express order carries an
  // address too, and it is just as worth keeping.
  if (order.mode !== 'pickup' && isCompleteAddress(order.address)) {
    saved.delivery_address = order.address
  }
  return saved
}

export function prefillFromProfile(profile: Profile | null | undefined): {
  name?: string
  wa?: string
  address?: AddressParts
} {
  if (!profile) return {}
  const prefill: { name?: string; wa?: string; address?: AddressParts } = {}
  if (profile.name) prefill.name = profile.name
  if (profile.whatsapp) prefill.wa = profile.whatsapp
  if (isAddressShaped(profile.delivery_address)) prefill.address = profile.delivery_address
  return prefill
}
