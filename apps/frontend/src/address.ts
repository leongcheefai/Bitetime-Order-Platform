import type { AddressParts } from './types'

// Renders a delivery address for display. Accepts the new structured object
// or a legacy free-text string (orders placed before the split). Empty parts
// are dropped so there are no stray commas.
export function formatAddress(addr: AddressParts | string | null | undefined): string {
  if (!addr) return ''
  if (typeof addr === 'string') return addr
  const cityLine = [addr.postcode, addr.city].filter(Boolean).join(' ')
  return [addr.line1, cityLine, addr.state].filter(Boolean).join(', ')
}
