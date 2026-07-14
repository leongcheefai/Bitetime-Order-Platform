import { sql } from './db.js'
import { phonesMatch } from './phone.js'

export interface OrderTracking {
  status: string | null
  mode: string | null
  courier: string | null
  awb: string | null
  created_at: string
}

/**
 * A guest's only way back to an order: the order number AND the phone they ordered with.
 *
 * Replaces the `track_order` SECURITY DEFINER function. That function was SECURITY DEFINER
 * because the anon path has no RLS grant to read a stranger's order; this connection is
 * RLS-exempt for the same reason and with the same consequence — **the merchant scope is
 * enforced here, in TypeScript, and nowhere else**. Drop `merchant_id` from the query and an
 * order number guessed on one shop reads back an order from another.
 *
 * A miss is a bare null, and the caller must not say which half was wrong. "No such order"
 * told apart from "wrong phone" is exactly the oracle the phone is here to take away.
 *
 * `order_number` is not unique in production (see init_schema), so `(merchant, number)` can
 * match more than one row. The phone picks between them — which is why every candidate is
 * fetched and the FIRST ONE WHOSE PHONE MATCHES is returned, rather than one arbitrary row
 * that is then phone-checked. The SQL this replaces had the phone inside its `where`, so its
 * `limit 1` chose among rows that already matched; narrowing to a single row first would
 * quietly return null for a customer whose order shares its number with someone else's.
 */
export async function trackOrder(
  merchantId: string,
  orderNumber: string,
  phone: string,
): Promise<OrderTracking | null> {
  if (!merchantId || !orderNumber.trim() || !phone.trim()) return null

  // Bound parameters, not interpolation — postgres.js's tagged template sends them out of
  // band. `customer_wa` is fetched to be compared and then dropped; it is PII and must never
  // reach the response, which is why the return below is built field by field.
  const rows = await sql<
    {
      status: string | null
      mode: string | null
      courier: string | null
      awb: string | null
      created_at: Date
      customer_wa: string | null
    }[]
  >`
    select o.status, o.mode, o.courier, o.awb, o.created_at, o.customer_wa
    from orders o
    where o.merchant_id = ${merchantId}
      and o.order_number = ${orderNumber.trim()}
    order by o.created_at
  `

  const order = rows.find(o => phonesMatch(o.customer_wa, phone))
  if (!order) return null

  // `created_at` arrives from the driver as a Date and the wire contract is an ISO string, so
  // convert it here. Leaning on c.json() to stringify it would type-check and serialise
  // identically while handing every in-process caller a Date that claims to be a string.
  return {
    status: order.status,
    mode: order.mode,
    courier: order.courier,
    awb: order.awb,
    created_at: order.created_at.toISOString(),
  }
}
