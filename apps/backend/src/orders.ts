import type postgres from 'postgres'
import { priceOrder, voucherFromRow, shopRates, shopTax, shopDistance, routedKm, exceedsMaxKm, productFromRow, promoClaims, fulfilmentConfig, isDateSelectable, DEFAULT_TIMEZONE } from '@bitetime/shared'
import type { PricedProduct, PricedVoucher, FulfilmentConfig, ShopTax, ShopDistance } from '@bitetime/shared'
import { sql, withTransaction } from './db.js'
import { COUNTER_START, formatOrderNumber, orderDay } from './orderNumber.js'
import { resolveDistance, CACHE_TTL_MS, type DistanceDeps } from './distance.js'
import { liveDistanceDeps } from './distanceCache.js'
import { quoteMerchantWindow, quoteIpWindow } from './quotaWindows.js'

/**
 * The machine-readable reasons an order can be refused. The storefront reacts to these, so
 * they are part of the wire contract — not prose to be reworded.
 *
 * DELIBERATE TWIN of `OrderErrorCode` in `apps/frontend/src/store.ts` (the frontend is a
 * separate workspace and cannot import this). Add a code here and it must be added there too,
 * with a customer-facing `t(en, zh)` message in Storefront.tsx's `handleSubmit` catch block
 * (VOUCHER_REFUSALS is the table for the voucher ones) — otherwise the customer is told
 * "something went wrong" for a refusal whose reason we know.
 */
export type OrderErrorCode =
  | 'merchant_not_found'
  | 'merchant_inactive'
  | 'voucher_not_found'
  | 'voucher_already_used'
  | 'voucher_fully_used'
  | 'voucher_requires_account'
  | 'price_changed'
  | 'product_unavailable'
  | 'delivery_state_required'
  | 'fulfil_date_unavailable'
  | 'fulfil_date_required'
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
   * The routing lookup itself did not happen, and the ONLY distance failure that is retryable
   * at all — but "retryable" covers two causes that recover on very different clocks, and the
   * wire code does not distinguish them:
   *
   *   * a provider outage — retryable within seconds, the ordinary case;
   *   * the shop's daily Google-spend ceiling (Finding 6, fix wave 2) — does NOT clear for up
   *     to 24 hours. A customer who retries this one moments later meets the same refusal.
   *
   * One code for both anyway: the customer's only available action is "try again later" either
   * way, and a fourth wire code would cost the frontend a twin for a distinction it cannot act
   * on differently.
   *
   * ONE EXCEPTION: a distance-priced shop whose configuration cannot price (`!policy.usable`)
   * also raises this code, and no amount of retrying fixes a merchant's own dormant/incomplete
   * setup — that would be the permanent-refusal-loop shape the ADR rejects elsewhere. This case
   * is now blocked at the schema level (`merchants_distance_requires_origin`, tightened to
   * refuse an empty-string origin too), so a shop that reaches intake in `distance` mode is
   * expected to always have a usable origin — but the check above still throws this same code
   * as the honest answer, since a config that predates the constraint or fails validation for
   * some other reason must not silently fall back to a dormant region rate.
   */
  | 'distance_lookup_failed'

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
): Promise<{ orderNumber: string }> {
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
    const distancePriced = merchant.distance.mode === 'distance'

    // A REGION-priced delivery with no state prices at ZERO — `shippingFee` reads the region off
    // the state, and with none it falls through to `return 0`. That is the same species of hole
    // the `mode` allowlist closed one field over: a fee zeroed by a value the client chose (here,
    // by a value the client simply left out), on an order that is still perfectly deliverable. It
    // is refused here rather than in the route because the region rules are this module's, not
    // HTTP's — and the Storefront's `deliveryReady` gate means no honest checkout ever sees it.
    //
    // A DISTANCE-priced shop has no such input: its destination was already resolved (or
    // refused) before this transaction opened, and the state is only ever printed on the parcel.
    if (input.mode === 'delivery' && !distancePriced && deliveryState(input.mode, input.address) === null) {
      throw new OrderError('delivery_state_required')
    }
    // The pre-transaction resolution and the authoritative row disagree only if the merchant
    // flipped their shipping policy between the routing call and this read. Fail closed rather
    // than price a delivery the routing call never ran for.
    if (input.mode === 'delivery' && distancePriced && routedMetres === null) {
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
    // exactly the voucher that was priced.
    const voucher = input.voucherCode
      ? await claimVoucher(tx, input.merchantId, input.voucherCode, input.userEmail)
      : null

    // Scoped to this merchant, and that predicate is the ONLY thing keeping a stranger's
    // product out of this cart: no RLS runs on this connection. LOCKED (`for update`), which is
    // what makes the promo cap real rather than a decoration two concurrent checkouts both walk
    // through.
    const products = await cartProducts(tx, input.merchantId, input.cart)

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
    const items = bd.lines.map(l => ({ id: l.id, name: l.name, qty: l.qty, price: l.unitPrice, promo: l.promo }))
    const discount = bd.discount > 0 ? bd.discount : null

    // The snapshot. `delivery_distance_km` LABELS the receipt line; base/rate exist because
    // `base + rate × km` has two unknowns and one equation, and without them no past order's fee
    // is reconstructable once the merchant edits their rates. Null for a region-priced shop.
    const distanceKm = distancePriced && routedMetres !== null ? routedKm(routedMetres) : null
    const distanceBase = distanceKm === null ? null : merchant.distance.base
    const distanceRate = distanceKm === null ? null : merchant.distance.ratePerKm

    await tx`
      insert into orders (
        merchant_id, user_id, customer_name, customer_wa, mode, address,
        shipping_fee, items, total, currency, discount, tax, tax_rate, voucher_code, fulfil_date, order_number, status,
        delivery_distance_km, delivery_base_fee, delivery_rate_per_km
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
        -- Hardcoded, never taken from the caller. A client could otherwise file an order that
        -- is already 'completed' — which the insert policy used to prevent and no longer can,
        -- because no policy runs on this connection.
        'new',
        ${distanceKm},
        ${distanceBase},
        ${distanceRate}
      )
    `

    return { orderNumber }
  })
}

/**
 * The routed distance for this order, or a refusal. `null` for any shop that is not
 * distance-priced and for any pickup — those price by the region rule and never route.
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
  if (input.mode !== 'delivery') return null

  const rows = await sql<Record<string, unknown>[]>`
    select id::text, status::text, shipping_mode, delivery_base_fee, delivery_rate_per_km, delivery_max_km, origin_place_id
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
  if (policy.mode !== 'distance') return null
  // A distance shop that cannot price does not fall back to its dormant region rate — that
  // charges by a formula the merchant switched off. It refuses.
  if (!policy.usable) throw new OrderError('distance_lookup_failed')

  const destination = (input.destinationPlaceId ?? '').trim()
  if (!destination) throw new OrderError('delivery_place_required')

  const notBefore = new Date(now.getTime() - CACHE_TTL_MS)
  // A cache read that throws degrades to a MISS, exactly as `resolveDistance` does with its own
  // read — and exactly as the quote endpoint's own peek does. This peek exists only to decide
  // whether the lookup below should cost the shop a slot of its daily ceiling, so a database
  // blip must not turn a resolvable delivery into a 500.
  let cached: number | null = null
  try {
    cached = await deps.readCache(policy.originPlaceId!, destination, notBefore)
  } catch (err) {
    console.error('Distance cache peek failed:', err instanceof Error ? err.message : String(err))
  }

  // A cache HIT costs nothing and must never consume a slot of the shop's daily ceiling; a MISS
  // is a real Google call and must. Identical rule to the quote endpoint, deliberately sharing
  // the SAME bucket — it is one bill for one shop, and intake is a second spender on it.
  if (cached === null) {
    // A COURTESY bound, not an abuse control, and worth being precise about: `clientIp` trusts
    // `cf-connecting-ip` first, and this backend does not sit behind Cloudflare, so a determined
    // caller rotates that header and mints a fresh key per request. What actually stops a runaway
    // is the per-shop ceiling below, which is keyed on the row's own id and cannot be re-spelled.
    // This one stops accidental hammering, and it is on the MISS path only: a blanket limit on
    // order placement would refuse legitimate customers behind carrier-grade NAT, which is worse
    // than the abuse it would prevent.
    if (input.callerIp && !quoteIpWindow.allow(input.callerIp)) {
      throw new OrderError('distance_lookup_failed')
    }
    if (!quoteMerchantWindow.allow(merchantId)) {
      throw new OrderError('distance_lookup_failed')
    }
  }

  const outcome = cached !== null
    ? ({ status: 'ok', metres: cached } as const)
    : await resolveDistance(
        deps,
        { originPlaceId: policy.originPlaceId!, destinationPlaceId: destination },
        now,
      )
  // No route and beyond-the-maximum are ONE refusal: same fact, same message.
  if (outcome.status === 'no_route') throw new OrderError('delivery_out_of_range')
  if (outcome.status === 'failed') throw new OrderError('distance_lookup_failed')
  if (exceedsMaxKm(policy, routedKm(outcome.metres))) throw new OrderError('delivery_out_of_range')
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
  }
  const rows = await tx<MerchantRow[]>`
    select order_prefix, status::text, shipping, currency, config, timezone, tax_enabled, tax_rate,
           shipping_mode, delivery_base_fee, delivery_rate_per_km, delivery_max_km, origin_place_id
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
  cart: Record<string, number>,
): Promise<PricedProduct[]> {
  const ids = Object.keys(cart).filter(id => (cart[id] ?? 0) > 0)
  // Unreachable over HTTP — app.ts's isCart already requires at least one positive quantity —
  // and kept as the module's own guard, not as a tested path. An empty cart must never reach
  // `= any('{}'::uuid[])`, which matches nothing and would commit an order for no products.
  if (ids.length === 0) throw new OrderError('product_unavailable')
  if (!ids.every(id => UUID.test(id))) throw new OrderError('product_unavailable')

  const rows = await tx<Record<string, unknown>[]>`
    select id, name, price, promo_price, promo_limit, promo_end, promo_sold
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
): Promise<PricedVoucher> {
  const entry = (userEmail ?? '').trim().toLowerCase()
  // A guest, or an account with no email address (phone-only auth). Either way the claim
  // cannot be keyed. Refused, never keyed on '' — every anonymous redemption would otherwise
  // collapse onto the same key, which once made a fifty-use voucher count as one.
  if (!entry) throw new OrderError('voucher_requires_account')

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
