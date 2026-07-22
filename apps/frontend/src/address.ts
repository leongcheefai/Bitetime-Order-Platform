import type { AddressParts } from './types'

// Renders a delivery address for display. Accepts the new structured object
// or a legacy free-text string (orders placed before the split). Empty parts
// are dropped so there are no stray commas.
export function formatAddress(addr: AddressParts | string | null | undefined): string {
  if (!addr) return ''
  if (typeof addr === 'string') return addr
  // A `place_id` marks `line1` as GOOGLE'S OWN formatted address string (`pickDestination` fills
  // it from the Places Details `formatted` field) — and that string already contains the
  // postcode, city and state. Appending the tail again printed every distance order's address
  // twice, on the receipt, the Telegram message and the dashboard alike (#101 review, Finding 3).
  // A region address carries no `place_id`; its `line1` is only the street the customer typed,
  // so the tail is still the only place those parts appear and must stay.
  if (addr.place_id) return [addr.unit, addr.line1].filter(Boolean).join(', ')
  const cityLine = [addr.postcode, addr.city].filter(Boolean).join(' ')
  // The unit leads, where a rider reads it first. Never routed — see AddressParts.unit.
  return [addr.unit, addr.line1, cityLine, addr.state].filter(Boolean).join(', ')
}
