import type postgres from 'postgres'
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
  mode: string
  address?: unknown
  shippingFee?: number
  items: unknown
  total: number
  currency?: string
  discount?: number | null
  voucherCode?: string | null
  voucherEntry?: string | null
}

/**
 * Take an order: bump the shop's daily counter, claim the voucher and insert the order —
 * all in ONE transaction, so they commit together or not at all.
 *
 * This is the whole ticket. Intake used to be three independent browser-to-Postgres calls,
 * and the storefront swallowed the third one's error: a failed redemption left the order
 * committed with the discount applied and the voucher never marked used, so the customer
 * kept the discount and could reuse the voucher indefinitely. Here a failed claim throws,
 * the transaction rolls back, and there is no second call left to swallow.
 *
 * TWO INVARIANTS ARE ENFORCED HERE AND NOWHERE ELSE, because db.ts connects as the database
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
 */
export function placeOrder(input: PlaceOrderInput, now = new Date()): Promise<{ orderNumber: string }> {
  return withTransaction(async (tx) => {
    const prefix = await assertOrderableMerchant(tx, input.merchantId)
    const day = orderDay(now)

    // Order matters for deadlock-freedom, not for correctness: every transaction takes the
    // counter row before the voucher row, so two concurrent orders can never hold one and
    // wait on the other.
    const orderNumber = formatOrderNumber(prefix, day, await nextCounterValue(tx, input.merchantId, day))

    if (input.voucherCode) {
      await claimVoucher(tx, input.merchantId, input.voucherCode, input.voucherEntry ?? '')
    }

    const discount = input.discount && input.discount > 0 ? input.discount : null

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
        ${input.shippingFee ?? 0},
        ${tx.json(input.items as never)},
        ${input.total},
        ${input.currency ?? 'MYR'},
        ${discount},
        -- The code is recorded only when it actually bought a discount, mirroring the insert
        -- the browser used to make.
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

/**
 * The intake gate: is this shop allowed to take an order at all? Returns its order-number
 * prefix, or throws.
 *
 * Deliberately NOT called the "Checkout gate" — CONTEXT.md already gives that name to the
 * sign-in / create-account / continue-as-guest step, which is a different thing in a
 * different layer. (#65 used the term for this check; the glossary wins.)
 */
async function assertOrderableMerchant(tx: postgres.TransactionSql, merchantId: string): Promise<string> {
  const rows = await tx<{ order_prefix: string; status: string }[]>`
    select order_prefix, status::text from merchants where id = ${merchantId}
  `
  const merchant = rows[0]
  if (!merchant) throw new OrderError('merchant_not_found')
  if (merchant.status !== 'active') throw new OrderError('merchant_inactive')
  return merchant.order_prefix
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
): Promise<void> {
  const entry = (rawEntry ?? '').trim().toLowerCase()
  // Inherited from redeem_voucher's hardening, and load-bearing: an empty entry cannot be
  // tracked one-per-customer, and every anonymous redemption would collapse onto the same ''
  // key — which once made a fifty-use voucher count as one.
  if (!entry) throw new OrderError('voucher_entry_required')

  const rows = await tx<{ id: string; max_uses: number | null; used_by: string[] }[]>`
    select id, max_uses, used_by from vouchers
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
}
