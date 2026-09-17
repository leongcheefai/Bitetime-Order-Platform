/**
 * The REFUSAL VOCABULARY: every code the backend can put in an error body on the two
 * customer-facing money paths — order intake (`POST /api/orders`) and the delivery quote
 * (`POST /api/shipping/quote`).
 *
 * It lives in `@bitetime/shared` for the reason `pricing.ts` does: it is a rule that must hold
 * identically on both sides of the wire. It used to be a hand-copied twin — `OrderErrorCode` in
 * `apps/backend/src/orders.ts` and again in `apps/frontend/src/store.ts` — kept in step by a
 * comment asking a human to remember. That failed: `method_not_offered` was added to the
 * backend, handled in `Storefront.tsx` as a bare string comparison, and never added to the
 * frontend's union, so the compiler could not see the gap.
 *
 * Adding a code now breaks BOTH builds until it is handled:
 *   * the backend fails on the missing `REFUSAL_STATUS` entry (the Record is TOTAL — no default);
 *   * the frontend fails on `orderRefusalPlan`'s exhaustiveness check.
 *
 * WHAT IS NOT HERE, DELIBERATELY: the customer's message and the recovery it triggers. The
 * backend renders neither, `t(en, zh)` lives in the browser's `SessionContext`, and two of the
 * messages depend on browser state (whether the shop offers pickup). They live in
 * `apps/frontend/src/store/orderRefusal.ts`.
 */

/** A refusal `POST /api/orders` can return. Thrown as `OrderError` inside the transaction, except where noted. */
export type OrderRefusal =
  /** No shop with that id. The only refusal here that is a 404. */
  | 'merchant_not_found'
  /** The shop exists but is not `active` — pending approval, or suspended. */
  | 'merchant_inactive'
  | 'voucher_not_found'
  /**
   * The caller has spent their own allowance (`per_customer_limit`, default 1).
   *
   * Was `voucher_already_used`. That name stopped being true when a merchant could set a limit
   * above 1: it fires on the fourth attempt at a three-use code, and states something false about
   * the other three. Same rule that renamed `orderCount` to `bookedOrders`.
   */
  | 'voucher_customer_limit_reached'
  /** The SHOP's total cap (`max_uses`) is spent. Nobody can redeem it. */
  | 'voucher_fully_used'
  /** The voucher's expiry has passed. Checked under the row lock, not only at pre-flight. */
  | 'voucher_expired'
  /**
   * The basket's subtotal is under the voucher's minimum. Refused rather than priced at a zero
   * discount, so the customer never burns a redemption for nothing.
   */
  | 'voucher_below_minimum'
  /**
   * A voucher's one-per-customer key is the verified JWT's email and nothing else. A guest has
   * no verified identity, so their claim is refused rather than keyed on something they can
   * vary at will.
   */
  | 'voucher_requires_account'
  /**
   * The backend priced the order differently from the quote the customer confirmed. NOTHING was
   * written — not even a counter slot. The response to this code alone also carries `now`, the
   * server's own clock, which is what lets a browser with a persistently unreachable `/api/time`
   * still recover (I-3, #69).
   */
  | 'price_changed'
  /** Something in the cart stopped being on sale mid-checkout. */
  | 'product_unavailable'
  /**
   * An option chosen on a line stopped being available mid-checkout — switched off, or removed
   * from the group. NOT `product_unavailable`, whose recovery is to refetch the menu so the
   * vanished id drops out of the cart: the product id still EXISTS here, so a refetch drops
   * nothing, the dead selection survives it, and every retry is refused identically. Recovery is
   * to repair the line (reopen the picker), falling back to dropping it when the whole group is
   * gone — that fallback is the terminating case, not a courtesy. See CONTEXT.md -> Menu options.
   */
  | 'option_unavailable'
  /**
   * A `delivery` that declared no state. Refused, never priced: with no state `shippingFee`
   * falls through to 0 and the shop would ship to Sabah for free.
   */
  | 'delivery_state_required'
  /** The chosen date is outside the shop's fulfilment window — reachable honestly by a checkout left open past midnight. */
  | 'fulfil_date_unavailable'
  /** No date on an order that needs one. */
  | 'fulfil_date_required'
  /** The chosen slot is outside the shop's hours, off the grid, or too close to now. Also: one end without the other (#282). */
  | 'fulfil_time_unavailable'
  /** No slot on an order at a shop that asks for one. */
  | 'fulfil_time_required'
  /**
   * A distance-priced shop was handed a delivery with no destination place id. The same rule as
   * `delivery_state_required` one policy over: an unresolvable destination is REFUSED, never
   * priced — with no distance, `shippingFee` would fall through to 0 and the shop would drive
   * 40 km for free.
   */
  | 'delivery_place_required'
  /**
   * Beyond the shop's `max_km`, OR no road route exists. ONE code, because to the customer they
   * are the same fact: this shop does not deliver there. Only `distance_lookup_failed` is worth
   * retrying.
   */
  | 'delivery_out_of_range'
  /**
   * The shop does not offer the method this order names. Checked in the transaction because the
   * flags live on the shop's row, which only the backend reads — the storefront renders no
   * button for a disabled method, so an honest checkout never sees this.
   *
   * THIS IS THE CODE THE HAND-COPIED TWIN LOST. It is the reason this module exists.
   */
  | 'method_not_offered'
  /**
   * The routing lookup itself did not happen, and the ONLY distance failure that is retryable
   * at all — but "retryable" covers two causes that recover on very different clocks, and the
   * wire code does not distinguish them:
   *
   *   * a provider outage — retryable within seconds, the ordinary case;
   *   * the shop's daily Google-spend ceiling — does NOT clear for up to 24 hours. A customer
   *     who retries this one moments later meets the same refusal.
   *
   * One code for both anyway: the customer's only available action is "try again later" either
   * way, and a fourth wire code would cost a distinction they cannot act on differently. It is
   * also why this code's copy must not promise "in a moment".
   *
   * ONE EXCEPTION: a distance-priced shop whose configuration cannot price (`!policy.usable`)
   * raises this code too, and no amount of retrying fixes a merchant's own incomplete setup.
   * The schema constraint `merchants_distance_requires_origin` is what makes that case rare;
   * the throw stays because a config that predates the constraint must not silently fall back
   * to a dormant region rate.
   */
  | 'distance_lookup_failed'
  /**
   * The ROUTE's own 400, not the transaction's — the body did not have the shape an order has,
   * almost always a cart past `MAX_CART_QTY` / `MAX_CART_LINES`. A permanent refusal: the same
   * cart is refused identically, so the copy must say what would change it.
   */
  | 'invalid_body'
  /** A server fault with no domain reason. The 500 catch-all; never thrown as an `OrderError`. */
  | 'order_failed'

/**
 * The HTTP status each refusal carries, and the reason a new code cannot be added quietly: this
 * Record is TOTAL and has no default, so `tsc` refuses a union member with no entry here. The
 * backend indexes it in `app.ts`'s `OrderError` handler.
 *
 * `invalid_body` and `order_failed` are listed because they are on the wire with those statuses,
 * even though the route emits them from their own paths rather than through the handler.
 */
export const REFUSAL_STATUS: Record<OrderRefusal, 400 | 404 | 409 | 500> = {
  merchant_not_found: 404,
  merchant_inactive: 409,
  voucher_not_found: 409,
  voucher_customer_limit_reached: 409,
  voucher_fully_used: 409,
  voucher_expired: 409,
  voucher_below_minimum: 409,
  voucher_requires_account: 409,
  price_changed: 409,
  product_unavailable: 409,
  option_unavailable: 409,
  delivery_state_required: 409,
  fulfil_date_unavailable: 409,
  fulfil_date_required: 409,
  fulfil_time_unavailable: 409,
  fulfil_time_required: 409,
  delivery_place_required: 409,
  delivery_out_of_range: 409,
  method_not_offered: 409,
  distance_lookup_failed: 409,
  invalid_body: 400,
  order_failed: 500,
}

/**
 * Every order refusal, at runtime. Derived from the status map's keys rather than written twice
 * — the map is total, so this list cannot fall behind the union.
 */
export const ORDER_REFUSALS = Object.keys(REFUSAL_STATUS) as readonly OrderRefusal[]

/** A refusal `POST /api/shipping/quote` can return. */
export type QuoteRefusal =
  /** No `merchantId` / `placeId` in the body. */
  | 'invalid_body'
  /** The per-IP sliding window. Cheap flood protection; clears in seconds. */
  | 'rate_limited'
  | 'merchant_not_found'
  | 'merchant_inactive'
  /** This shop does not price by distance, or its distance configuration cannot price. */
  | 'not_distance_priced'
  /**
   * The shop's daily ceiling on billable provider calls, charged only on a cache miss. Does NOT
   * clear for up to 24 hours — which is why it must not be shown as "try again".
   */
  | 'quota_exceeded'
  /** Beyond `max_km`, or no road route. One fact, one code — the quote path's twin of `delivery_out_of_range`. */
  | 'out_of_range'
  /** The routing lookup itself failed. The one code here worth retrying soon. */
  | 'lookup_failed'

/** Total, for the same reason `REFUSAL_STATUS` is. Read by the quote route. */
export const QUOTE_REFUSAL_STATUS: Record<QuoteRefusal, 400 | 404 | 409 | 429> = {
  invalid_body: 400,
  rate_limited: 429,
  merchant_not_found: 404,
  merchant_inactive: 409,
  not_distance_priced: 409,
  quota_exceeded: 429,
  out_of_range: 409,
  lookup_failed: 409,
}

/** Every quote refusal, at runtime. Derived from the map's keys, as above. */
export const QUOTE_REFUSALS = Object.keys(QUOTE_REFUSAL_STATUS) as readonly QuoteRefusal[]
