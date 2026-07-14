/**
 * What a cart is allowed to be — the ONE rule, held by both sides of the wire.
 *
 * The backend refuses a cart that breaks these caps (`invalid_body`, 400), and it must: a
 * quantity has no natural ceiling in JSON, `Number.isInteger(1e21)` is TRUE, and the quote
 * check cannot save us because the client quotes the same astronomical total it asked for. The
 * cap is the only thing standing in front of an order for a trillion cookies.
 *
 * They live HERE, and not as a `1000` in the backend and another `1000` in the storefront,
 * because the frontend has to STOP the customer at the same ceiling the backend refuses at. A
 * cart the UI happily builds and the server then rejects is a dead checkout — the customer is
 * told `invalid_body` and given nothing to do about it. Two magic numbers that must agree are
 * the same class of bug the shared pricing module exists to kill.
 */

/** The most of any ONE product a single order may carry. */
export const MAX_CART_QTY = 1000

/** The most DISTINCT products a single order may carry. */
export const MAX_CART_LINES = 100

/**
 * A cart is product ids → positive whole quantities, within the caps.
 *
 * The shape check is not tidiness: a non-numeric quantity coerces to NaN, sails past
 * TypeScript, reaches Postgres and comes back a 500 — a bad request dressed up as a server
 * fault. Reject it at the door instead.
 */
export function isCart(v: unknown): v is Record<string, number> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const entries = Object.entries(v as Record<string, unknown>)
  if (entries.length === 0 || entries.length > MAX_CART_LINES) return false
  return entries.every(
    ([, qty]) => typeof qty === 'number' && Number.isInteger(qty) && qty > 0 && qty <= MAX_CART_QTY,
  )
}
