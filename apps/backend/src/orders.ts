import type postgres from 'postgres'
import { priceOrder, voucherFromRow, shopRates } from '@bitetime/shared'
import type { PricedProduct, PricedVoucher } from '@bitetime/shared'
import { withTransaction } from './db.js'
import { COUNTER_START, formatOrderNumber, orderDay } from './orderNumber.js'

/**
 * The machine-readable reasons an order can be refused. The storefront reacts to these, so
 * they are part of the wire contract — not prose to be reworded.
 *
 * DELIBERATE TWIN of `OrderErrorCode` in `apps/frontend/src/store.ts` (the frontend is a
 * separate workspace and cannot import this). Add a code here and it must be added there too,
 * with a customer-facing message in Storefront.tsx's VOUCHER_REFUSALS — otherwise the
 * customer is told "something went wrong" for a refusal whose reason we know.
 */
export type OrderErrorCode =
  | 'merchant_not_found'
  | 'merchant_inactive'
  | 'voucher_not_found'
  | 'voucher_already_used'
  | 'voucher_fully_used'
  | 'voucher_entry_required'
  | 'price_changed'
  | 'product_unavailable'

/** A refusal the customer can act on, as opposed to a bug. Thrown inside the transaction. */
export class OrderError extends Error {
  constructor(readonly code: OrderErrorCode) {
    super(code)
    this.name = 'OrderError'
  }
}

export interface PlaceOrderInput {
  merchantId: string
  /** From the verified JWT, or null for a guest. NEVER from the request body — see below. */
  userId: string | null
  customerName: string
  customerWa: string
  /**
   * The two modes the Storefront offers, as a UNION and not a string — `mode` selects the
   * shipping fee, so a free string is a client-chosen value that can zero one. It was a
   * string, and `mode: 'sameday'` bought a delivery with a shipping_fee of 0.
   *
   * 'sameday' is DELIBERATELY absent: it is unreachable from the Storefront and has no rate
   * behind it (`shippingFee` reads a `samedayFee` nobody passes, so it prices at 0). It is
   * tracked separately — do not re-widen this union without giving it a real rate.
   */
  mode: 'pickup' | 'delivery'
  address?: unknown
  /** What they want, not what it costs. `{ [productId]: qty }`. */
  cart: Record<string, number>
  /**
   * The total the customer SAW. A confirmation to check, not an input to trust: the order
   * commits at the price this function derives, and only when the two agree.
   */
  quotedTotal: number
  voucherCode?: string | null
  voucherEntry?: string | null
}

/**
 * Take an order: bump the shop's daily counter, claim the voucher, PRICE THE ORDER and insert
 * it — all in ONE transaction, so they commit together or not at all.
 *
 * This is the whole ticket. Intake used to be three independent browser-to-Postgres calls,
 * and the storefront swallowed the third one's error: a failed redemption left the order
 * committed with the discount applied and the voucher never marked used, so the customer
 * kept the discount and could reuse the voucher indefinitely. Here a failed claim throws,
 * the transaction rolls back, and there is no second call left to swallow.
 *
 * THREE INVARIANTS ARE ENFORCED HERE AND NOWHERE ELSE, because db.ts connects as the database
 * owner and no RLS policy runs on it:
 *
 *   * The CHECKOUT GATE — the shop exists and is active, asserted before anything is written.
 *     The orders_insert_guest_or_customer policy used to do this and does not run on us.
 *   * ATTRIBUTION — `userId` comes from the verified JWT. The orders_set_user_id trigger now
 *     COALESCEs rather than overwrites (it must: there is no auth.uid() on this connection),
 *     which means a settable user_id reaching it is trusted. That is safe only because
 *     anon/authenticated no longer hold INSERT on orders — so if this function ever starts
 *     reading user_id from a request body, it hands every anon-key holder the ability to push
 *     an order into a stranger's history. Do not add it to PlaceOrderInput's caller.
 *   * THE PRICE — every number on the order row is derived HERE, from the products, the shop's
 *     shipping rates and the claimed voucher. The body carries a cart and the total the
 *     customer saw; it carries no prices. It used to carry `total`, and a client could simply
 *     POST `total: 0` and have the order commit at zero. A price the caller can state is not a
 *     price. The quote is checked, never trusted: disagree with it and the order is REFUSED
 *     (`price_changed`), never silently re-priced upward — a customer must not be charged a
 *     number they did not see.
 */
export function placeOrder(input: PlaceOrderInput, now = new Date()): Promise<{ orderNumber: string }> {
  return withTransaction(async (tx) => {
    const merchant = await assertOrderableMerchant(tx, input.merchantId)
    const day = orderDay(now)

    // Scoped to this merchant, and that predicate is the ONLY thing keeping a stranger's
    // product out of this cart: no RLS runs on this connection.
    const products = await cartProducts(tx, input.merchantId, input.cart)

    // Order matters for deadlock-freedom, not for correctness: every transaction takes the
    // counter row before the voucher row, so two concurrent orders can never hold one and
    // wait on the other.
    const orderNumber = formatOrderNumber(merchant.order_prefix, day, await nextCounterValue(tx, input.merchantId, day))

    // The claim and the discount read the same locked row, so the voucher that is spent is
    // exactly the voucher that was priced.
    const voucher = input.voucherCode
      ? await claimVoucher(tx, input.merchantId, input.voucherCode, input.voucherEntry ?? '')
      : null

    const bd = priceOrder({
      products,
      cart: input.cart,
      mode: input.mode,
      // Read off the address that is actually being shipped to, so the region that sets the
      // rate and the region on the parcel cannot disagree.
      state: deliveryState(input.mode, input.address),
      rates: merchant.rates,
      voucher,
      now,
    })

    assertQuoteHolds(bd.total, input.quotedTotal)

    const items = bd.lines.map(l => ({ id: l.id, name: l.name, qty: l.qty, price: l.unitPrice }))
    const discount = bd.discount > 0 ? bd.discount : null

    await tx`
      insert into orders (
        merchant_id, user_id, customer_name, customer_wa, mode, address,
        shipping_fee, items, total, currency, discount, voucher_code, order_number, status
      ) values (
        ${input.merchantId},
        ${input.userId},
        ${input.customerName},
        ${input.customerWa},
        ${input.mode},
        ${tx.json((input.address ?? null) as never)},
        ${bd.shipping},
        ${tx.json(items as never)},
        ${bd.total},
        ${merchant.currency},
        -- The code is recorded only when it actually bought a discount, mirroring the insert
        -- the browser used to make.
        ${discount},
        ${discount ? (input.voucherCode ?? null) : null},
        ${orderNumber},
        -- Hardcoded, never taken from the caller. A client could otherwise file an order that
        -- is already 'completed' — which the insert policy used to prevent and no longer can,
        -- because no policy runs on this connection.
        'new'
      )
    `

    return { orderNumber }
  })
}

interface OrderableMerchant {
  order_prefix: string
  rates: { WM: number; EM: number }
  currency: string
}

/**
 * The intake gate: is this shop allowed to take an order at all? Returns what pricing it
 * needs, or throws.
 *
 * Deliberately NOT called the "Checkout gate" — CONTEXT.md already gives that name to the
 * sign-in / create-account / continue-as-guest step, which is a different thing in a
 * different layer. (#65 used the term for this check; the glossary wins.)
 */
async function assertOrderableMerchant(tx: postgres.TransactionSql, merchantId: string): Promise<OrderableMerchant> {
  const rows = await tx<{ order_prefix: string; status: string; shipping: unknown; currency: string | null }[]>`
    select order_prefix, status::text, shipping, currency from merchants where id = ${merchantId}
  `
  const merchant = rows[0]
  if (!merchant) throw new OrderError('merchant_not_found')
  if (merchant.status !== 'active') throw new OrderError('merchant_inactive')
  return {
    order_prefix: merchant.order_prefix,
    // shopRates, not a local fallback: the storefront quotes from the same function, and the
    // penalty for the two disagreeing is now a REFUSAL (`price_changed`), not a rounding gap.
    rates: shopRates(merchant.shipping),
    currency: merchant.currency ?? 'MYR',
  }
}

/** `products.id` is a uuid. A cart key that is not one cannot name a product. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The cart's products, scoped to this merchant and to what is actually on sale.
 *
 * An id that comes back missing is REFUSED, not dropped: a cart quietly shrinking to the
 * products that happen to exist would commit an order the customer never placed, at a total
 * they never saw.
 *
 * The ids are shape-checked before they reach the query, and that is not fussiness: the
 * comparison casts to `uuid[]`, so a cart key of `'nope'` would raise a Postgres cast error
 * and surface as a 500 — a bad request dressed up as a server fault. It is a refusal, and the
 * client is told so.
 *
 * `Number(row.price)` is not defensive either. postgres.js returns `numeric` as a STRING to
 * preserve precision, so `price` arrives as '13.00' and would reach round2's `.toFixed()`
 * and throw.
 */
async function cartProducts(
  tx: postgres.TransactionSql,
  merchantId: string,
  cart: Record<string, number>,
): Promise<PricedProduct[]> {
  const ids = Object.keys(cart).filter(id => (cart[id] ?? 0) > 0)
  // Unreachable over HTTP — app.ts's isCart already requires at least one positive quantity —
  // and kept as the module's own guard, not as a tested path. An empty cart must never reach
  // `= any('{}'::uuid[])`, which matches nothing and would commit an order for no products.
  if (ids.length === 0) throw new OrderError('product_unavailable')
  if (!ids.every(id => UUID.test(id))) throw new OrderError('product_unavailable')

  const rows = await tx<{ id: string; name: string; price: string }[]>`
    select id, name, price from products
    where merchant_id = ${merchantId} and id = any(${ids}::uuid[]) and active
  `
  // Every requested id must have come back. Fewer means one is another shop's, inactive, or
  // gone — and we cannot tell the customer WHICH without leaking whether a stranger's product
  // id exists, so all three are one refusal.
  if (rows.length !== ids.length) throw new OrderError('product_unavailable')

  return rows.map(r => ({ id: r.id, name: r.name, price: Number(r.price) }))
}

/** The state that sets the shipping region — only a delivery has one. */
function deliveryState(mode: PlaceOrderInput['mode'], address: unknown): string | null {
  if (mode !== 'delivery') return null
  if (!address || typeof address !== 'object') return null
  const state = (address as Record<string, unknown>).state
  return typeof state === 'string' && state ? state : null
}

/**
 * The quote the customer confirmed must be the price they are charged.
 *
 * Compared in cents: both sides are already round2'd, so an exact integer-cent comparison is
 * the honest one — a float `===` would refuse orders over a phantom 0.000001.
 *
 * A mismatch is a REFUSAL, not a correction. The shop's prices moved under a customer who is
 * mid-checkout; committing at the new number would charge them something they never agreed to,
 * and committing at the old one would let a stale quote buy a discount. The storefront
 * re-prices and asks them again.
 */
function assertQuoteHolds(computed: number, quoted: number): void {
  const cents = (n: number) => Math.round(n * 100)
  if (!Number.isFinite(quoted) || cents(computed) !== cents(quoted)) {
    throw new OrderError('price_changed')
  }
}

/**
 * The shop's next daily counter value, as one atomic upsert — the same statement
 * next_order_number ran, and for the same reason: two concurrent checkouts must never read
 * the same value and hand two customers the same order number. A read-then-write in
 * TypeScript would do exactly that.
 *
 * A new day resets to COUNTER_START rather than continuing, and the row is keyed by merchant
 * alone (not by day), so yesterday's row is what today's order updates.
 */
async function nextCounterValue(tx: postgres.TransactionSql, merchantId: string, day: string): Promise<number> {
  const rows = await tx<{ value: number }[]>`
    insert into order_counters (merchant_id, day, value)
      values (${merchantId}, ${day}, ${COUNTER_START})
    on conflict (merchant_id) do update
      set day   = ${day},
          value = case when order_counters.day = ${day}
                       then order_counters.value + 1
                       else ${COUNTER_START} end
    returning value
  `
  return rows[0].value
}

/**
 * Claim one redemption of a voucher, under a row lock.
 *
 * `for update` is not optional and is the reason this needs a real driver: without it, two
 * concurrent checkouts both read a fifty-use voucher at forty-nine uses and both write fifty
 * — and a cap that only holds when nobody is racing it is not a cap. The lock is held until
 * the surrounding transaction ends, so the loser reads the winner's write, not the stale row.
 */
async function claimVoucher(
  tx: postgres.TransactionSql,
  merchantId: string,
  code: string,
  rawEntry: string,
): Promise<PricedVoucher> {
  const entry = (rawEntry ?? '').trim().toLowerCase()
  // Inherited from redeem_voucher's hardening, and load-bearing: an empty entry cannot be
  // tracked one-per-customer, and every anonymous redemption would collapse onto the same ''
  // key — which once made a fifty-use voucher count as one.
  if (!entry) throw new OrderError('voucher_entry_required')

  // `kind` and `amount` are selected because THIS row is what the order is priced from — the
  // discount must come from the voucher that was locked, not from a second, unlocked read.
  const rows = await tx<{ id: string; code: string; kind: string; amount: string; max_uses: number | null; used_by: string[] }[]>`
    select id, code, kind, amount, max_uses, used_by from vouchers
    where merchant_id = ${merchantId} and code = ${code}
    for update
  `
  const voucher = rows[0]
  if (!voucher) throw new OrderError('voucher_not_found')

  // One redemption per customer. A re-redeem is an error, never a silent no-op — the caller
  // has to be able to block the duplicate rather than re-grant the discount.
  if (voucher.used_by.includes(entry)) throw new OrderError('voucher_already_used')

  // A null cap is unlimited in total, still one per customer via the check above.
  if (voucher.max_uses !== null && voucher.used_by.length >= voucher.max_uses) {
    throw new OrderError('voucher_fully_used')
  }

  await tx`
    update vouchers set used_by = used_by || ${tx.json([entry] as never)}
    where id = ${voucher.id}
  `
  return voucherFromRow(voucher as unknown as Record<string, unknown>)
}
