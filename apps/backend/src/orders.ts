import type postgres from 'postgres'
import { priceOrder, validateSelections, voucherFromRow, voucherExpired, voucherBelowMinimum, shopRates, shopTax, shopDistance, shopMethods, offersMethod, routedKm, isDistancePriced, productFromRow, promoClaims, fulfilmentConfig, isDateSelectable, DEFAULT_TIMEZONE } from '@bitetime/shared'
import type { CartLine, PricedProduct, PricedVoucher, FulfilmentConfig, ShopTax, ShopDistance, ShopMethods, OrderRefusal, OrderEvent } from '@bitetime/shared'
import { sql, withTransaction } from './db.js'
import { recordOrderEvents, SYSTEM_ACTOR, type OrderActor } from './orderEventsDb.js'
import { orderPatchEvents, type OrderPatch, type OrderPatchBefore } from './orderEvents.js'
import { syncOrderRedemptionVoid } from './voucherRedemptionsDb.js'
import { phoneKey } from './phone.js'
import { COUNTER_START, formatOrderNumber, orderDay } from './orderNumber.js'
import { type DistanceDeps } from './distance.js'
import { resolveRoutedDistance } from './routedDistance.js'
import { liveDistanceDeps } from './distanceCache.js'
import { quoteMerchantWindow, quoteIpWindow } from './quotaWindows.js'

/**
 * The codes this module refuses with. They used to be declared here and hand-copied into the
 * frontend, which drifted — see `packages/shared/src/refusal.ts`, which now owns the vocabulary,
 * each code's meaning, and the HTTP status it carries. Adding a code there fails this build
 * until `REFUSAL_STATUS` names its status, and fails the frontend's until the storefront gives
 * it copy.
 */
export type OrderErrorCode = OrderRefusal

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
  /**
   * From the verified JWT, or null for a guest. NEVER from the request body.
   *
   * This is the voucher's ONE-PER-CUSTOMER KEY. It used to be `voucherEntry`, a string the
   * BODY supplied — so the same person re-redeemed a one-per-customer voucher forever by
   * varying it (`a@b.com`, `a+1@b.com`, `x`), and a voucher with a null `max_uses` was an
   * unlimited discount for one person. A key the client can name is not a key.
   */
  userEmail: string | null
  customerName: string
  customerWa: string
  /**
   * The method the customer chose, as a UNION and not a string — `mode` selects the shipping
   * fee, so a free string is a client-chosen value that can zero one. It was a string, and
   * `mode: 'sameday'` bought a delivery with a shipping_fee of 0.
   *
   * `delivery` is the flat region rate and `express` is distance-priced. Whether this shop
   * OFFERS the named method is checked in the transaction (`method_not_offered`).
   */
  mode: 'pickup' | 'delivery' | 'express'
  address?: unknown
  /** What they want, not what it costs. `{ [productId]: qty }`. */
  cart: CartLine[]
  /**
   * The total the customer SAW. A confirmation to check, not an input to trust: the order
   * commits at the price this function derives, and only when the two agree.
   */
  quotedTotal: number
  voucherCode?: string | null
  /**
   * The date the customer asked for, `YYYY-MM-DD`, on the SHOP's clock.
   *
   * Checked here against the shop's own window, never taken on trust: the picker that produced
   * it runs in the customer's browser, and a body is a body.
   */
  fulfilDate: string | null
  /**
   * The destination's stable place identifier, lifted off the address the customer submitted.
   *
   * The DESTINATION is a fact only the customer can supply, so it arrives in the request — but
   * as an identifier, and the DISTANCE is never taken from the body. That is the same shape as
   * the region rule one policy over: the customer declares where the parcel goes, the shop's own
   * rows decide what that costs. A body-supplied distance is the `total: 0` hole with extra steps.
   */
  destinationPlaceId?: string | null
  /**
   * The caller's address — for the miss-path SPEND BOUND only (Finding 2, fix wave 2), never
   * for attribution and never persisted. `userId`/`userEmail` above are what attribution reads;
   * this is not a second one.
   *
   * Optional: a caller that omits it (this module's own tests, which drive `placeOrder`
   * directly and never go through `app.ts`) simply skips the per-IP leg of the miss-path bound
   * below — the per-shop ceiling still applies unconditionally either way.
   */
  callerIp?: string
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
export async function placeOrder(
  input: PlaceOrderInput,
  now = new Date(),
  distanceDeps: DistanceDeps = liveDistanceDeps,
): Promise<{ orderNumber: string; id: string; status: string }> {
  // THE ROUTING CALL HAPPENS HERE, OUTSIDE THE TRANSACTION, and that placement is the whole
  // reason this function is no longer a bare `withTransaction(...)`. Inside, the transaction
  // holds this shop's single `order_counters` row lock, which serialises every checkout at that
  // shop — a third party's network round-trip under that lock would queue the entire shop's
  // intake behind Google's latency.
  //
  // A cache HIT is the normal case — the customer quoted moments ago, and that quote wrote the
  // row. A miss re-resolves. A distance that MOVED in the meantime does not need a new failure
  // path: the derived total disagrees with the quoted total and the existing `price_changed`
  // refusal fires, which the storefront already knows how to recover from.
  const routedMetres = await resolveRoutedMetres(input, distanceDeps, now)

  return withTransaction(async (tx) => {
    const merchant = await assertOrderableMerchant(tx, input.merchantId)

    // BEFORE the fee rules, because "you cannot order that way here" is the answer to give when
    // both could fire: a shop with express switched off should not be told its distance lookup
    // failed.
    if (!offersMethod(merchant.methods, input.mode)) {
      throw new OrderError('method_not_offered')
    }

    // The SAME rule `priceOrder` branches on, not a second reading of it: this decides whether a
    // distance is charged, and disagreeing with the module that computes the fee is a refused
    // checkout at best and a wrong charge at worst.
    const distancePriced = isDistancePriced(input.mode)

    // A REGION-priced delivery with no state prices at ZERO — `shippingFee` reads the region off
    // the state, and with none it falls through to `return 0`. That is the same species of hole
    // the `mode` allowlist closed one field over: a fee zeroed by a value the client chose (here,
    // by a value the client simply left out), on an order that is still perfectly deliverable. It
    // is refused here rather than in the route because the region rules are this module's, not
    // HTTP's — and the Storefront's `deliveryReady` gate means no honest checkout ever sees it.
    //
    // A `delivery` order is ALWAYS region-priced, whatever else the shop offers, so it always
    // needs a state. An `express` order takes its fee from the routed distance instead.
    if (input.mode === 'delivery' && deliveryState(input.mode, input.address) === null) {
      throw new OrderError('delivery_state_required')
    }
    // The pre-transaction resolution and the authoritative row disagree only if the merchant
    // flipped their methods between the routing call and this read. Fail closed rather than
    // price an express order the routing call never ran for.
    if (input.mode === 'express' && routedMetres === null) {
      throw new OrderError('distance_lookup_failed')
    }

    // Before the counter moves. A refused date must cost the shop nothing — not a burnt order
    // number, not a claimed voucher — and throwing here rolls back a transaction that has not
    // yet written anything anyway.
    //
    // Two codes, not one: "you sent nothing" and "the shop is not taking that day" are
    // different things for the customer to do about, and the storefront says so.
    if (input.fulfilDate == null || input.fulfilDate === '') {
      throw new OrderError('fulfil_date_required')
    }
    if (!isDateSelectable(input.fulfilDate, merchant.fulfilment, merchant.timezone, now)) {
      throw new OrderError('fulfil_date_unavailable')
    }

    const day = orderDay(now)

    // Lock order is counter → voucher → products, and every intake takes it in that order.
    // `order_counters` is ONE row per merchant, so it serialises the shop's intake before any
    // voucher or product row is ever touched — the same reason the ordering used to be
    // "counter, then voucher" alone. Products moved to LAST because cartProducts now takes
    // `for update` locks of its own (the promo cap): nothing about correctness depends on this
    // order, only deadlock-freedom, and putting the counter first is what makes that trivial.
    const orderNumber = formatOrderNumber(merchant.order_prefix, day, await nextCounterValue(tx, input.merchantId, day))

    // The claim and the discount read the same locked row, so the voucher that is spent is
    // exactly the voucher that was priced. The redemption ROW is written later, once the order it
    // belongs to exists — see `claimVoucher`.
    const claimed = input.voucherCode
      ? await claimVoucher(tx, input.merchantId, input.voucherCode, input.userEmail, now)
      : null
    const voucher = claimed?.voucher ?? null

    // Scoped to this merchant, and that predicate is the ONLY thing keeping a stranger's
    // product out of this cart: no RLS runs on this connection. LOCKED (`for update`), which is
    // what makes the promo cap real rather than a decoration two concurrent checkouts both walk
    // through.
    const products = await cartProducts(tx, input.merchantId, input.cart)

    // The answers are checked against the SHOP'S OWN groups, here, inside the lock — the body
    // says which options, and whether those are still legal options is never its to assert.
    // Without this an option the merchant switched off at 3pm would still price and still sell.
    assertSelectionsHold(products, input.cart)

    const bd = priceOrder({
      products,
      cart: input.cart,
      mode: input.mode,
      // Read off the address that is actually being shipped to. That is where the fee's REGION
      // comes from, and the region is the one price input the client still supplies: the state
      // is a self-declared <select> value, not derived from the postcode, so a customer can let
      // 88000 autofill "Sabah" and then flip it to "Selangor" and pay the cheaper rate. What is
      // guaranteed is only that the rate charged is the rate for the state ON THE PARCEL — the
      // shop ships to whatever this says. Under-declaring the region is therefore a dispute the
      // merchant can see and settle, not a silent zero; a MISSING state was the silent zero,
      // and is refused above.
      state: deliveryState(input.mode, input.address),
      rates: merchant.rates,
      distance: merchant.distance,
      routedMetres,
      voucher,
      tax: merchant.tax,
      now,
    })

    // The minimum, refused rather than silently priced at a zero discount. `priceOrder` has
    // already dropped the discount for the same reason (`voucherApplies`); this is what stops the
    // customer spending a redemption to receive nothing. The subtotal is the priced one — the
    // number the rule is defined against, pre-discount, food only.
    if (voucher && voucherBelowMinimum(voucher, bd.subtotal)) {
      throw new OrderError('voucher_below_minimum')
    }

    // A pending fee is never committed. Unreachable — the refusals above cover every route to
    // it — and asserted anyway, because the one thing this feature must never do is charge a
    // delivery fee of 0 that nobody chose.
    if (bd.shippingPending) throw new OrderError('distance_lookup_failed')

    assertQuoteHolds(bd.total, input.quotedTotal)

    // Claim the promo units, under the lock `cartProducts` already took. A promo that sold out
    // between the customer's quote and this moment has already surfaced as `price_changed`
    // above — they are shown the new total and asked to confirm it, never silently charged more.
    //
    // The UPDATE is not trusted blind: `products_promo_sold_guard` silently DISCARDS this write
    // for any role outside {postgres, service_role, supabase_admin}, with no error and no log.
    // If this connection ever runs as anything else — a pooler, a different prod DATABASE_URL —
    // the order would commit, the counter would never move, and the cap would fail OPEN with
    // nothing to show for it. So the claim reads back `promo_sold` and throws if it did not
    // advance by exactly what was claimed, which aborts (and rolls back) the whole order rather
    // than let it commit against a cap that silently didn't move.
    for (const [id, qty] of Object.entries(promoClaims(bd, products))) {
      const before = products.find(p => p.id === id)!.promoSold ?? 0
      const claimed = await tx<{ promo_sold: number }[]>`
        update products set promo_sold = promo_sold + ${qty}
        where id = ${id}
        returning promo_sold
      `
      if (claimed.length !== 1 || claimed[0].promo_sold !== before + qty) {
        throw new Error(
          `promo_sold for product ${id} did not advance by ${qty} (expected ${before + qty}, ` +
          `got ${claimed[0]?.promo_sold ?? 'no row'}) — the promo cap may be failing open`,
        )
      }
    }

    // `promo` rides along so the split is explainable after the fact — without it two entries
    // sharing a name at different prices (the base/promo split, I-2) reads as a pricing bug to
    // anyone looking at the stored order later, not just at checkout. `orders.items` is a jsonb
    // blob with no schema, so every consumer must treat a MISSING key (rows written before this
    // field existed) as `false`, never as a crash.
    // `selections` is spread in only when the line has any, so an order at a shop with no menu
    // options stores exactly the item shape it always did. It is a SNAPSHOT — names in both
    // languages and the delta CHARGED — never a reference: a merchant tidying their menu next
    // month must not rewrite this month's receipts, and the groups live in a jsonb column, so no
    // foreign key would stop them.
    const items = bd.lines.map(l => ({
      id: l.id, name: l.name, qty: l.qty, price: l.unitPrice, promo: l.promo,
      ...(l.selections?.length ? { selections: l.selections } : {}),
    }))
    const discount = bd.discount > 0 ? bd.discount : null

    // The snapshot. `delivery_distance_km` LABELS the receipt line; base/rate exist because
    // `base + rate × km` has two unknowns and one equation, and without them no past order's fee
    // is reconstructable once the merchant edits their rates. Null for a region-priced shop.
    const distanceKm = distancePriced && routedMetres !== null ? routedKm(routedMetres) : null
    const distanceBase = distanceKm === null ? null : merchant.distance.base
    const distanceRate = distanceKm === null ? null : merchant.distance.ratePerKm

    const [{ id, status }] = await tx<{ id: string; status: string }[]>`
      insert into orders (
        merchant_id, user_id, customer_name, customer_wa, customer_phone_key, mode, address,
        shipping_fee, items, total, currency, discount, tax, tax_rate, voucher_code, fulfil_date, order_number, status,
        delivery_distance_km, delivery_base_fee, delivery_rate_per_km
      ) values (
        ${input.merchantId},
        ${input.userId},
        ${input.customerName},
        ${input.customerWa},
        -- Which shop customer this order belongs to (#143, ADR 0007). Stamped from phoneKey()
        -- — the SAME function guest order tracking matches on — so the two can never come to
        -- disagree about who is one person. In TypeScript rather than as a generated column:
        -- one rule, one language. The door already refused a number with no digits, so this
        -- is never null on a new order; older rows carry the migration's backfill.
        ${phoneKey(input.customerWa)},
        ${input.mode},
        ${tx.json((input.address ?? null) as never)},
        ${bd.shipping},
        ${tx.json(items as never)},
        ${bd.total},
        ${merchant.currency},
        ${discount},
        -- Derived from the shop's own row inside this transaction, NEVER from the body — the
        -- same rule as total and user_id above. A client-supplied tax is a client-chosen total.
        ${bd.tax},
        ${bd.taxRate},
        -- The code is recorded only when it actually bought a discount, mirroring the insert
        -- the browser used to make.
        ${discount ? (input.voucherCode ?? null) : null},
        ${input.fulfilDate},
        ${orderNumber},
        -- Born pending_payment when the shop takes manual payment (has bank/QR/note to show the
        -- customer) — #182. Otherwise 'new', unchanged. Never taken from the caller, same reason
        -- as always: a client-chosen status is a client-chosen workflow state.
        ${merchant.hasPaymentInfo ? 'pending_payment' : 'new'},
        ${distanceKm},
        ${distanceBase},
        ${distanceRate}
      )
      returning id, status
    `

    // The redemption, now that the order it was spent on exists. Still inside the transaction and
    // still under the voucher's row lock, so a failure here rolls the order back — the property
    // that made the claim part of this transaction in the first place (#122's swallowed redeem).
    await claimed?.claim(id)

    // The order's first event, in the same transaction (ADR 0025). The actor is the customer
    // whether or not they have an account — a guest is a customer with no id, and the log tells
    // the two apart by `actor_id` alone.
    await recordOrderEvents(
      tx,
      { id, merchantId: input.merchantId },
      { kind: 'customer', id: input.userId },
      [{ kind: 'created', detail: { status } }],
    )

    // The status is returned, not re-derived by the caller. It decides whether the order-placed
    // screen can offer the invoice at all (a `pending_payment` order cannot be issued one), and
    // the shape of the rule — "born pending_payment when the shop takes manual payment" — is
    // stated once, here, in the statement that actually writes it.
    return { orderNumber, id, status }
  })
}

/**
 * The shop an order belongs to — the one thing the payment-proof upload needs before it can
 * accept a file, and the one thing it must never take from the caller. An order id names its
 * own shop; a client-supplied merchantId would let anyone attach a proof image into any shop's
 * folder. `null` for a missing OR malformed id — the caller only ever needs to know "not found",
 * and a hand-typed id in the URL is the same failure as a real one that was never placed.
 *
 * A malformed id is the ONLY error swallowed into that `null` — Postgres's own `22P02` (invalid
 * input syntax for uuid). Anything else is a real database failure and must not present as a
 * plain 404: that would fail OPEN exactly where `requireOwnsChild` (mw.ts) deliberately fails
 * closed for the sibling case ("A FAILED QUERY IS NOT 'no such row'"). Rethrown, so the caller's
 * catch turns it into a 500.
 */
export async function orderMerchantId(orderId: string): Promise<string | null> {
  try {
    const rows = await sql<{ merchant_id: string }[]>`
      select merchant_id from orders where id = ${orderId}
    `
    return rows[0]?.merchant_id ?? null
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: string }).code === '22P02') return null
    throw err
  }
}

/**
 * Stamps a receipt's storage path onto the order row, and advances a pending order past the
 * payment gate (#182) in the same statement — a receipt landing on the order IS the gate
 * clearing, whichever side put it there. The CASE guard is deliberate: it moves an order OUT of
 * pending_payment and never overwrites any other status, so a proof landing after a merchant
 * already cancelled (or completed) the order leaves that decision alone.
 *
 * One transaction with the order log (ADR 0025): the upload event as the uploader's, and — when
 * the gate cleared — a `status_changed` by the SYSTEM, because whoever attached the file did not
 * choose a workflow state. The events are returned for the merchant route's response.
 *
 * Two columns, never one: what the customer attached and what the shop filed are different
 * claims, and neither upload may replace the other's evidence (20260828120000).
 */
async function recordProof<C extends 'payment_proof' | 'payment_proof_merchant'>(
  orderId: string,
  column: C,
  path: string,
  kind: 'payment_proof_uploaded' | 'merchant_payment_proof_uploaded',
  actor: (row: ProofWriteRow) => OrderActor,
): Promise<(Record<C, string> & { status: string; events: OrderEvent[] }) | null> {
  return withTransaction(async (tx) => {
    // The column is one of two literals this function's own signature names — never caller text.
    const col = tx(column as string)
    const rows = await tx<(ProofWriteRow & Record<C, string>)[]>`
      update orders o
      set ${col} = ${path},
          status = case when o.status = 'pending_payment' then 'new' else o.status end
      from (select id, status as prev_status from orders where id = ${orderId} for update) p
      where o.id = p.id
      returning o.${col}, o.status, p.prev_status, o.merchant_id, o.user_id
    `
    const row = rows[0]
    if (!row) return null
    const order = { id: orderId, merchantId: row.merchant_id }
    const events = await recordOrderEvents(tx, order, actor(row), [{ kind, detail: {} }])
    if (row.prev_status !== row.status) {
      events.push(...await recordOrderEvents(tx, order, SYSTEM_ACTOR, [
        { kind: 'status_changed', detail: { from: row.prev_status ?? 'new', to: row.status } },
      ]))
    }
    return { [column]: row[column], status: row.status, events } as Record<C, string> & { status: string; events: OrderEvent[] }
  })
}

type ProofWriteRow = { status: string; prev_status: string | null; merchant_id: string; user_id: string | null }

/**
 * The customer's upload. The actor is the order's own `user_id`: the customer door has no auth,
 * and the order's owner is the only person that route lets upload for it. A guest is a customer
 * with no id.
 */
export function setOrderPaymentProof(orderId: string, path: string) {
  return recordProof(orderId, 'payment_proof', path, 'payment_proof_uploaded', row => ({ kind: 'customer', id: row.user_id }))
}

/** The shop's own copy — filed when the customer sent the slip over WhatsApp. The actor is the merchant who filed it. */
export function setOrderMerchantPaymentProof(orderId: string, path: string, merchantUserId: string) {
  return recordProof(orderId, 'payment_proof_merchant', path, 'merchant_payment_proof_uploaded', () => ({ kind: 'merchant', id: merchantUserId }))
}

/**
 * The merchant's PATCH of an order — status, note, courier, awb — as ONE transaction with the
 * order log and the voucher void (ADR 0025). Reads the row under lock, writes the patch, records
 * one event per field that actually moved, and voids or restores the redemption when the status
 * crossed `cancelled` (ADR 0023) — logging that as the SYSTEM'S doing, since the merchant chose
 * a status and not a voucher outcome. An empty patch is refused by the caller; a patch of
 * identical values commits, changes nothing and records nothing.
 *
 * A completed order's status is FINAL (ADR 0024), and that is judged HERE, on the row this
 * transaction holds locked — not on the row the route loaded a moment earlier, which another
 * device may have completed since. Only a status that DIFFERS is refused: a retried patch must
 * stay a no-op rather than become an error. `{ refused }` is returned, not thrown, so the
 * transaction ends having written nothing and the route answers 409.
 *
 * `null` when there is no such order. Tenancy is the caller's — `requireOwnsChild` proved the
 * id — and `patch` must already be through `pickOrderFields`: this spreads its keys into the
 * statement.
 */
/** Why a merchant patch was not applied. Each is a wire code the drawer has words for. */
export type PatchRefusal = 'order_completed' | 'fulfil_date_unavailable'

export async function patchOrder(
  orderId: string,
  patch: OrderPatch,
  merchantUserId: string,
): Promise<{ events: OrderEvent[] } | { refused: PatchRefusal } | null> {
  return withTransaction(async (tx) => {
    // The shop's clock and its Fulfilment settings ride along with the row: a date is judged by
    // the rule intake applies, against the SHOP's today, and reading both under the lock is what
    // makes the judgement match the row it is about. `fulfil_date::text` because the driver would
    // otherwise hand a `date` column back as a JS Date, and the event's `from` must be the same
    // `YYYY-MM-DD` string the `to` is.
    const [before] = await tx<(OrderPatchBefore & { merchant_id: string; voucher_code: string | null; timezone: string | null; config: unknown })[]>`
      select o.status, o.note, o.courier, o.awb, o.fulfil_date::text, o.merchant_id, o.voucher_code, m.timezone, m.config
      from orders o join merchants m on m.id = o.merchant_id
      where o.id = ${orderId} for update of o
    `
    if (!before) return null
    const completed = (before.status ?? 'new') === 'completed'
    if (patch.status !== undefined && completed && patch.status !== 'completed') {
      return { refused: 'order_completed' as const }
    }
    if (patch.fulfil_date !== undefined) {
      // A completed order's date is as final as its status (ADR 0024): the goods have been
      // handed over, and the day they were handed over on is not the merchant's to rewrite.
      // Only a date that DIFFERS is refused, for the same reason the status rule reads that way.
      if (completed && patch.fulfil_date !== (before.fulfil_date ?? null)) {
        return { refused: 'order_completed' as const }
      }
      // The CUSTOMER's rule, on purpose: the shop's lead time, window, closed weekdays and
      // ticked dates are what the merchant told the platform they can serve, and the drawer must
      // not be a door around their own settings — a merchant who closes Mondays and then moves an
      // order to a Monday has either changed their mind (the Fulfilment tab is where that goes)
      // or mis-clicked. Same rule, same refusal code, as a stray POST to intake.
      const open = isDateSelectable(patch.fulfil_date, fulfilmentConfig(before.config), before.timezone ?? DEFAULT_TIMEZONE, new Date())
      if (!open) return { refused: 'fulfil_date_unavailable' as const }
    }

    await tx`update orders set ${tx(patch as Record<string, string | null>)} where id = ${orderId}`

    const order = { id: orderId, merchantId: before.merchant_id }
    const events = await recordOrderEvents(tx, order, { kind: 'merchant', id: merchantUserId }, orderPatchEvents(before, patch))

    if (patch.status !== undefined) {
      const cancelled = patch.status === 'cancelled'
      const moved = await syncOrderRedemptionVoid(tx, orderId, cancelled)
      if (moved > 0) {
        events.push(...await recordOrderEvents(tx, order, SYSTEM_ACTOR, [
          { kind: cancelled ? 'voucher_released' : 'voucher_restored', detail: { code: before.voucher_code } },
        ]))
      }
    }
    return { events }
  })
}

/**
 * The routed distance for this order, or a refusal. `null` for any mode that is not `express`
 * — pickup and flat-rate delivery price by their own rules and never route.
 *
 * Reads the shop's policy on a NON-transactional connection: the authoritative read is still
 * the one inside `assertOrderableMerchant`, and the price is still derived in there. This read
 * exists only to know whether to route at all, and what origin to route from.
 */
async function resolveRoutedMetres(
  input: PlaceOrderInput,
  deps: DistanceDeps,
  now: Date,
): Promise<number | null> {
  if (input.mode !== 'express') return null

  const rows = await sql<Record<string, unknown>[]>`
    select id::text, status::text, express_enabled, delivery_base_fee, delivery_rate_per_km, delivery_max_km, origin_place_id
    from merchants where id = ${input.merchantId}
  `
  // The shop's status is checked HERE as well as inside the transaction, and the duplication is
  // deliberate: the in-transaction check is the authority on whether an order may commit, but it
  // runs too late to stop the Google lookup below from being paid for. A suspended shop must not
  // be a way to spend the platform's money.
  if (!rows[0]) throw new OrderError('merchant_not_found')
  if ((rows[0].status as string) !== 'active') throw new OrderError('merchant_inactive')

  // Keyed on the ROW's id, never on `input.merchantId`. Postgres parses uuids leniently —
  // upper-case, brace-wrapped and hyphen-free spellings all match the same row — so a ceiling
  // keyed on the body's string is one an unauthenticated caller re-keys at will, four spellings
  // deep, for four times the free lookups. Same trap the cart keys already carry a canonical-
  // form rule for (CONTEXT.md → Order pricing): with money on the other side, it is not style.
  const merchantId = rows[0].id as string

  const policy = shopDistance(rows[0])
  // Not this shop's method. The transaction refuses it with `method_not_offered`; returning null
  // here just means no Google call is paid for on the way to that refusal.
  if (!policy.enabled) return null
  // A distance shop that cannot price does not fall back to its dormant region rate — that
  // charges by a formula the merchant switched off. It refuses.
  if (!policy.usable) throw new OrderError('distance_lookup_failed')

  const destination = (input.destinationPlaceId ?? '').trim()
  if (!destination) throw new OrderError('delivery_place_required')

  // The peek, the per-shop daily ceiling and the no-route / beyond-max-km mapping all live in
  // `resolveRoutedDistance`, shared with the quote endpoint so the number quoted and the number
  // charged cannot drift apart (#119). What is intake-specific stays here: the courtesy per-IP
  // bound, run via `onMiss` so it fires only on a real Google call, and the mapping of the
  // wire-agnostic outcome to this module's OrderError codes.
  const outcome = await resolveRoutedDistance(policy, destination, deps, now, {
    merchantKey: merchantId,
    merchantWindow: quoteMerchantWindow,
    // A COURTESY bound, not an abuse control: `clientIp` trusts `cf-connecting-ip` first, and this
    // backend does not sit behind Cloudflare, so a determined caller rotates that header and mints
    // a fresh key per request. What actually stops a runaway is the per-shop ceiling above, keyed
    // on the row's own id and unspoofable. This one stops accidental hammering, on the MISS path
    // only: a blanket limit on order placement would refuse legitimate customers behind carrier-
    // grade NAT, which is worse than the abuse it would prevent.
    onMiss: () => {
      if (input.callerIp && !quoteIpWindow.allow(input.callerIp)) {
        throw new OrderError('distance_lookup_failed')
      }
    },
  })
  // No route and beyond-the-maximum are ONE refusal: same fact, same message. A spent ceiling and
  // a provider failure both read as "could not work out the fee just now" on intake's side.
  if (outcome.status === 'out_of_range') throw new OrderError('delivery_out_of_range')
  if (outcome.status === 'quota_exceeded') throw new OrderError('distance_lookup_failed')
  if (outcome.status === 'failed') throw new OrderError('distance_lookup_failed')
  return outcome.metres
}

interface OrderableMerchant {
  order_prefix: string
  rates: { WM: number; EM: number }
  currency: string
  fulfilment: FulfilmentConfig
  timezone: string
  tax: ShopTax
  distance: ShopDistance
  methods: ShopMethods
  hasPaymentInfo: boolean
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
  // The intersection keeps the open-key access `shopDistance`/`shopTax` need (they take
  // `unknown` and read whatever columns they want off it) while restoring the compiler's
  // protection on the fields THIS function reads by name — `Record<string, unknown>` alone let
  // `merchant.order_prefx` (a typo) compile and yield `undefined` at runtime, on the function
  // that derives the order prefix, currency, rates and tax.
  type MerchantRow = Record<string, unknown> & {
    order_prefix: string
    status: string
    currency: string | null
    timezone: string | null
    payment_bank: string | null
    payment_qr: string | null
    payment_note: string | null
  }
  const rows = await tx<MerchantRow[]>`
    select order_prefix, status::text, shipping, currency, config, timezone, tax_enabled, tax_rate,
           pickup_enabled, delivery_enabled, express_enabled,
           delivery_base_fee, delivery_rate_per_km, delivery_max_km, origin_place_id,
           payment_bank, payment_qr, payment_note
    from merchants where id = ${merchantId}
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
    // Same argument as shopRates one line up: the picker is BUILT from this function, so intake
    // must judge with it. A second reading of the bag here is a second rule, and the customer
    // meets it as a refusal of a date the picker just offered them.
    fulfilment: fulfilmentConfig(merchant.config),
    timezone: merchant.timezone ?? DEFAULT_TIMEZONE,
    // shopTax, for the same reason as shopRates above: the storefront quotes from this exact
    // function, and the penalty for the two disagreeing is a REFUSAL, not a rounding gap.
    // postgres.js hands `tax_rate` back as a string; the mapper is what knows that.
    tax: shopTax(merchant),
    // shopDistance, for the same reason as shopRates and shopTax above: the storefront quotes
    // from this exact function and the quote endpoint quotes from it, and a disagreement is a
    // REFUSAL, not a rounding gap. postgres.js hands these numerics back as strings.
    distance: shopDistance(merchant),
    // shopMethods, for the same reason as shopRates, shopTax and shopDistance above: the
    // storefront renders its buttons from this exact function, and a second reading here is a
    // second rule the customer meets as a refusal of a button they were just offered.
    methods: shopMethods(merchant),
    // #182: an order is born pending_payment only when the customer will actually SEE somewhere
    // to send proof — the same condition Storefront.tsx uses to render the upload widget. A shop
    // with none of the three has no upload surface, so gating it would strand every order.
    hasPaymentInfo: Boolean(merchant.payment_bank || merchant.payment_qr || merchant.payment_note),
  }
}

/**
 * `products.id` is a uuid. A cart key that is not one cannot name a product.
 *
 * NO `i` FLAG. This is not a style choice — an uppercase-but-otherwise-valid uuid is how a FREE
 * ORDER used to commit. Postgres compares `uuid` values case-insensitively, so an uppercase key
 * matches a lowercase `id` in `= any(${ids}::uuid[])` just fine and sails past the "every id came
 * back" check. But JavaScript `===` does not, and `priceOrder` finds each cart line by
 * `products.find(p => p.id === id)` — so the line matched NOTHING and was silently dropped
 * (`continue`): `lines: []`, `subtotal: 0`, and on a pickup a `total` of 0 that
 * `assertQuoteHolds(0, 0)` waved straight through.
 *
 * The storefront only ever emits lowercase uuids (Postgres canonicalises them on the way out), so
 * refusing anything else costs no honest customer a thing. Do NOT "fix" this by lowercasing the
 * key instead: an uppercase and a lowercase form of the SAME id in one cart would then merge into
 * one line at double the quantity, defeating MAX_CART_QTY. Refuse, do not normalise.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The cart's products, scoped to this merchant, on sale, and LOCKED.
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
 * `for update` is the promo cap. Without it two concurrent checkouts both read the last promo
 * unit and both take it — the same reason `claimVoucher` holds a lock, and a cap that only
 * holds when nobody is racing it is not a cap. The lock is held until the transaction ends, so
 * the loser reads the winner's write.
 *
 * `order by id` so two carts holding the same products in a different order cannot deadlock
 * against each other. (Nothing else could anyway — every intake takes the merchant's single
 * `order_counters` row first, which serialises the shop's intake — but the ordering costs
 * nothing and does not depend on that staying true.)
 *
 * Rows go through `productFromRow`: postgres.js returns `numeric` as a STRING, and the browser
 * quoted from PostgREST's numbers. Two mappings would refuse every promo order — and every
 * ordinary one, since `price` goes through the same mapper.
 */
async function cartProducts(
  tx: postgres.TransactionSql,
  merchantId: string,
  cart: CartLine[],
): Promise<PricedProduct[]> {
  // DISTINCT product ids: one product can hold several lines now that its options can differ, and
  // `= any(...::uuid[])` with a repeated id returns ONE row, which would then fail the
  // "every requested id came back" count below and refuse a perfectly good cart.
  const ids = [...new Set(cart.filter(l => (l.qty ?? 0) > 0).map(l => l.productId))]
  // Unreachable over HTTP — app.ts's isCart already requires at least one positive quantity —
  // and kept as the module's own guard, not as a tested path. An empty cart must never reach
  // `= any('{}'::uuid[])`, which matches nothing and would commit an order for no products.
  if (ids.length === 0) throw new OrderError('product_unavailable')
  if (!ids.every(id => UUID.test(id))) throw new OrderError('product_unavailable')

  const rows = await tx<Record<string, unknown>[]>`
    select id, name, price, promo_price, promo_limit, promo_end, promo_sold, option_groups
    from products
    where merchant_id = ${merchantId} and id = any(${ids}::uuid[]) and active
    order by id
    for update
  `
  // Every requested id must have come back. Fewer means one is another shop's, inactive, or
  // gone — and we cannot tell the customer WHICH without leaking whether a stranger's product
  // id exists, so all three are one refusal.
  if (rows.length !== ids.length) throw new OrderError('product_unavailable')

  return rows.map(productFromRow)
}

/**
 * The state that sets the shipping region — only a delivery has one.
 *
 * `null` on a delivery is not a default, it is a REFUSAL (`delivery_state_required`, raised by
 * the caller): it would price the delivery at 0.
 */
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
 * Claim one redemption of a voucher, under a row lock, keyed to a VERIFIED account.
 *
 * `for update` is not optional and is the reason this needs a real driver: without it, two
 * concurrent checkouts both read a fifty-use voucher at forty-nine uses and both write fifty
 * — and a cap that only holds when nobody is racing it is not a cap. The lock is held until
 * the surrounding transaction ends, so the loser reads the winner's write, not the stale row.
 *
 * The key comes from the JWT and from nowhere else. A voucher therefore REQUIRES AN ACCOUNT:
 * a guest has no verified identity, so their claim cannot be keyed to anything they cannot
 * also change, and an unkeyable claim is refused rather than keyed on something spoofable.
 * That is a deliberate product decision (#72) and it costs us a first-time customer holding a
 * promo code, who now meets a sign-in prompt. It is what makes the cap real.
 */
async function claimVoucher(
  tx: postgres.TransactionSql,
  merchantId: string,
  code: string,
  userEmail: string | null,
  now: Date,
): Promise<{ voucher: PricedVoucher; claim: (orderId: string) => Promise<void> }> {
  const entry = (userEmail ?? '').trim().toLowerCase()
  // A guest, or an account with no email address (phone-only auth). Either way the claim
  // cannot be keyed. Refused, never keyed on '' — every anonymous redemption would otherwise
  // collapse onto the same key, which once made a fifty-use voucher count as one.
  if (!entry) throw new OrderError('voucher_requires_account')

  // `kind` and `amount` are selected because THIS row is what the order is priced from — the
  // discount must come from the voucher that was locked, not from a second, unlocked read.
  //
  // The lock is what makes every count below real. It is taken here and held to commit, so the
  // two concurrent checkouts that both read the last slot cannot both take it.
  const rows = await tx<{
    id: string; code: string; kind: string; amount: string; max_uses: number | null
    per_customer_limit: number | null; expires_at: string | null; min_order: string | null
  }[]>`
    select id, code, kind, amount, max_uses, per_customer_limit, expires_at, min_order
    from vouchers
    where merchant_id = ${merchantId} and code = ${code} and active
    for update
  `
  const row = rows[0]
  // `active` is folded into the lookup rather than checked after it, so an inactive voucher is
  // indistinguishable from a missing one here and reuses `voucher_not_found`. This is a column
  // filter on a row the transaction was already reading, and it must stay one — a billing lookup
  // on the checkout path is a slow or wrong answer costing a real order.
  //
  // It also disambiguates the PARTIAL unique index: `(merchant_id, code) where active` allows a
  // retired row and a live row to share a code, so a lookup on the string alone would be
  // ambiguous. `and active` is what keeps this exactly one row.
  if (!row) throw new OrderError('voucher_not_found')

  const voucher = voucherFromRow(row as unknown as Record<string, unknown>)

  // Counted under the lock, from `voucher_redemptions` — not from a jsonb array's length. Two
  // counts, and they answer different questions: how many this PERSON has taken, and how many the
  // CODE has taken. `used_by` was a set, and a set cannot answer the first one now that a customer
  // may hold several (#241).
  //
  // `voided_at is null` is what makes releasing a cancelled order's redemption real. It is the
  // ONLY count that frees a slot for a customer: every other reader of this table is a display
  // figure, so a filter missing here would leave the dashboard saying a slot is free while the
  // checkout kept refusing it. See ADR 0023.
  const [counts] = await tx<{ mine: string; total: string }[]>`
    select
      count(*) filter (where customer_key = ${entry}) as mine,
      count(*) as total
    from voucher_redemptions
    where voucher_id = ${row.id} and voided_at is null
  `
  const mine = Number(counts?.mine ?? 0)
  const total = Number(counts?.total ?? 0)

  // A null per-customer limit is unlimited, and the column defaults to 1 — the rule every voucher
  // predating #241 was created under. A re-redeem past the allowance is an error, never a silent
  // no-op: the caller has to be able to block the duplicate rather than re-grant the discount.
  if (row.per_customer_limit != null && mine >= row.per_customer_limit) {
    throw new OrderError('voucher_customer_limit_reached')
  }

  // A null cap is unlimited in total, still bounded per customer by the check above. The database
  // refuses BOTH being null (`vouchers_bounded`), so this pair can never be an open till.
  if (row.max_uses !== null && total >= row.max_uses) {
    throw new OrderError('voucher_fully_used')
  }

  // Expiry is refused HERE as well as dropped in `priceOrder`, and the two are not redundant.
  // `priceOrder` stops the money; this stops the REDEMPTION. Without it a customer holding an
  // expired code would commit an order at full price and burn one of their allowance on a
  // discount of zero. The MINIMUM is the same rule and is checked by the caller, once the cart has
  // been priced — it needs a subtotal, and the products are not loaded until after this lock.
  if (voucherExpired(voucher, now)) throw new OrderError('voucher_expired')

  // The WRITE is deferred, and the reason is `order_id`. The claim's checks must run here, before
  // pricing, under the lock; the redemption row wants the order it was spent on, and that row does
  // not exist yet. Both happen inside ONE transaction, so the pair commits whole or not at all —
  // and the lock taken above is still held when the insert runs, so no second checkout can slip
  // between the count and the write.
  return {
    voucher,
    claim: async (orderId: string) => {
      await tx`
        insert into voucher_redemptions (voucher_id, customer_key, order_id, redeemed_at)
        values (${row.id}, ${entry}, ${orderId}, ${now})
      `
    },
  }
}

/**
 * Every line's answer must still be a legal answer to its product's questions.
 *
 * The split between the two refusals is about what a CORRECT client could produce. A menu that
 * moved under a customer mid-checkout is ordinary and recoverable — an option switched off, a
 * group deleted, a `minSelect` the merchant raised — so those are `option_unavailable`, whose
 * recovery repairs the line and lets the customer choose again. A fractional quantity or two
 * answers to one group is something no correct client sends, so that is `invalid_body`, the same
 * answer the cart caps give.
 *
 * Getting this backwards costs a real checkout: `invalid_body` offers the customer nothing to do,
 * and a refusal with no recovery on a menu that simply changed is a dead order.
 */
function assertSelectionsHold(products: PricedProduct[], cart: CartLine[]): void {
  for (const line of cart) {
    const product = products.find(p => p.id === line.productId)
    // Unreachable — `cartProducts` refuses a cart holding an id it could not load — and guarded
    // rather than assumed, because skipping here would price an unchecked answer.
    if (!product) throw new OrderError('product_unavailable')

    const bad = validateSelections(product.optionGroups ?? [], line.selections)
    if (!bad) continue
    throw new OrderError(
      bad === 'invalid_pick' || bad === 'duplicate_group' ? 'invalid_body' : 'option_unavailable',
    )
  }
}
