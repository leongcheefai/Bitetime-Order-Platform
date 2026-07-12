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

/** Every part filled in. A half-typed address is not worth remembering. */
function isCompleteAddress(a: AddressParts | undefined | null): a is AddressParts {
  return !!a && [a.line1, a.postcode, a.city, a.state].every(part => typeof part === 'string' && part.trim() !== '')
}

/** The shape the form works in. `delivery_address` is jsonb and will hold whatever it was last given. */
function isAddressShaped(a: unknown): a is AddressParts {
  if (!a || typeof a !== 'object') return false
  const parts = a as Record<string, unknown>
  return ['line1', 'postcode', 'city', 'state'].every(k => typeof parts[k] === 'string')
}

export function savedDetailsFromOrder(order: {
  mode: 'pickup' | 'delivery'
  wa: string
  address: AddressParts
}): SavedDetails {
  const saved: SavedDetails = {}
  const whatsapp = order.wa.trim()
  if (whatsapp) saved.whatsapp = whatsapp
  // A pickup order carries no address. Writing the form's empty one would blank the address the
  // customer saved on their last delivery — and they would only discover it at the next checkout.
  if (order.mode === 'delivery' && isCompleteAddress(order.address)) {
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
