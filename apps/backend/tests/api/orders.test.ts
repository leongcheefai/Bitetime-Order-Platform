// tests/api/orders.test.ts
// POST /api/orders — order intake, in one transaction, driven in-process against real Postgres.
//
// This suite is the reason the endpoint exists. Order intake used to be three independent
// browser-to-Postgres calls with no transaction around them, and the storefront threw the
// third one's error away with an empty catch: a failed redemption left the order inserted
// with the discount applied and the voucher never marked used, so the customer kept the
// discount and could reuse the voucher forever.
//
// Two classes of assertion here cannot be faked and must never be mocked:
//
//   * ROLLBACK — a failed voucher claim leaves NO order row and NO burnt counter slot. A
//     mocked database would report green while proving nothing about Postgres.
//   * CONCURRENCY — the counter's atomic upsert and the voucher's SELECT … FOR UPDATE are
//     the only things standing between a fifty-use voucher and five hundred redemptions.
//     These tests fire real concurrent requests through real row locks.
//
// db.ts is RLS-EXEMPT, so the intake gate (merchant active, status = 'new') and the
// attribution rule (user_id comes from the JWT, never the body) are TypeScript invariants on
// this path. Everything asserting them below is load-bearing, not decoration.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import postgres from 'postgres'
import { app } from '../../src/app.js'
import { env } from '../../src/env.js'
import { makeUser, resetMerchant, seedMerchant, seedProduct, serviceClient } from '../rls/helpers.js'
import { orderDay } from '../../src/orderNumber.js'
import { placeOrder, OrderError, type PlaceOrderInput } from '../../src/orders.js'
import type { DistanceDeps, DistanceOutcome } from '../../src/distance.js'
import { sqlDistanceCache } from '../../src/distanceCache.js'
import { quoteMerchantWindow, quoteIpWindow } from '../../src/quotaWindows.js'
import { MAX_CART_QTY, MAX_CART_LINES, todayInZone, DEFAULT_TIMEZONE } from '@bitetime/shared'

const SLUGS = ['ord-shop', 'ord-pending', 'ord-suspended', 'ord-distance']
const DAY = orderDay(new Date())

/** A cart of 2 × RM13 = 26, shaped like the one the storefront now sends. */
function body(merchantId: string, productId: string, extra: Record<string, unknown> = {}) {
  return {
    merchantId,
    customerName: 'Ah Meng',
    customerWa: '60123456789',
    mode: 'pickup',
    cart: { [productId]: 2 },
    quotedTotal: 26,
    ...extra,
  }
}

function post(payload: unknown, token?: string) {
  return app.request('/api/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  })
}

/** The refusal code off a response. `Response.json()` is `unknown`, and `.error` on it will not compile. */
async function errorOf(res: Response) {
  return ((await res.json()) as { error?: string }).error
}

const svc = () => serviceClient()

async function ordersOf(merchantId: string) {
  const { data } = await svc().from('orders').select('*').eq('merchant_id', merchantId)
  return data ?? []
}

async function counterOf(merchantId: string) {
  const { data } = await svc().from('order_counters').select('*').eq('merchant_id', merchantId).maybeSingle()
  return data
}

async function voucherOf(merchantId: string, code: string) {
  const { data } = await svc().from('vouchers').select('*').eq('merchant_id', merchantId).eq('code', code).maybeSingle()
  return data
}

async function seedVoucher(merchantId: string, code: string, maxUses: number | null) {
  await svc().from('vouchers').delete().eq('merchant_id', merchantId).eq('code', code)
  const { error } = await svc()
    .from('vouchers')
    .insert({ merchant_id: merchantId, code, kind: 'fixed', amount: 5, max_uses: maxUses, used_by: [] })
  if (error) throw new Error(`seeding voucher ${code}: ${error.message}`)
}

async function productOf(productId: string) {
  const { data } = await svc().from('products').select('*').eq('id', productId).maybeSingle()
  return data
}

/** A date the default fulfilment config is certainly taking: today + 1, on the shop's clock. */
function tomorrowInShopZone(): string {
  const today = todayInZone(DEFAULT_TIMEZONE, new Date())
  const ms = Date.parse(`${today}T00:00:00Z`) + 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * Patch a merchant's `config.fulfilment`, preserving whatever else `config` holds —
 * `fulfilmentConfig` (the same function order intake and the picker both read through)
 * falls back per field, but a plain column update would blow away the rest of the bag.
 */
async function setFulfilmentConfig(merchantId: string, cfg: Record<string, unknown>) {
  const { data } = await svc().from('merchants').select('config').eq('id', merchantId).single()
  const config = { ...((data?.config as Record<string, unknown>) ?? {}), fulfilment: cfg }
  const { error } = await svc().from('merchants').update({ config }).eq('id', merchantId)
  if (error) throw new Error(`setting fulfilment config for ${merchantId}: ${error.message}`)
}

/**
 * A fresh product with a promo, seeded in the SAME two-statement shape as tests/rls/promo.test.ts:
 * the guard resets promo_sold to 0 whenever promo_price changes (any role, including the service
 * client), so a non-zero promo_sold has to land in a LATER update that never touches promo_price.
 */
async function seedPromoProduct(merchantId: string, opts: {
  price: number
  promoPrice: number
  promoLimit?: number | null
  promoEnd?: string | null
  promoSold?: number
}) {
  const id = await seedProduct({ merchant_id: merchantId, price: opts.price })
  const priced = await svc()
    .from('products')
    .update({ promo_price: opts.promoPrice, promo_limit: opts.promoLimit ?? null, promo_end: opts.promoEnd ?? null })
    .eq('id', id)
  if (priced.error) throw new Error(`seeding promo product (price): ${priced.error.message}`)
  if (opts.promoSold) {
    const sold = await svc().from('products').update({ promo_sold: opts.promoSold }).eq('id', id)
    if (sold.error) throw new Error(`seeding promo product (sold): ${sold.error.message}`)
  }
  return id
}

/**
 * A fake `DistanceDeps` for driving `placeOrder` directly — the seam it takes `distanceDeps`
 * for. Only the routing PROVIDER is faked (`lookup`); `readCache`/`writeCache` are faked too,
 * but that is standing in for the distance cache, not the database this suite's rule forbids
 * mocking — `placeOrder` still runs every statement inside the transaction (the counter, the
 * products, the insert) against the real Postgres started by `test:db`.
 *
 * `cached` stands in for a "seeded cache row": non-null and the peek in `resolveRoutedMetres`
 * hits, so `lookup` is never called at all. `lookupCalls()` is what proves that.
 */
function fakeDistanceDeps(opts: { cached?: number | null; outcome?: DistanceOutcome }): {
  deps: DistanceDeps
  lookupCalls: () => number
} {
  let calls = 0
  const deps: DistanceDeps = {
    lookup: async () => {
      calls++
      return opts.outcome ?? { status: 'failed' }
    },
    readCache: async () => opts.cached ?? null,
    writeCache: async () => {},
  }
  return { deps, lookupCalls: () => calls }
}

/**
 * `DistanceDeps` with ONLY the provider faked — `readCache`/`writeCache` are the REAL
 * `sqlDistanceCache`, run against the real Postgres this suite already seeds `distance_quotes`
 * into (the ORIGIN/NEAR/FAR rows in the `distance-priced intake` describe block below).
 *
 * `fakeDistanceDeps` above cannot tell a genuine cache hit from a genuine miss: it fakes
 * `readCache` itself, and `resolveDistance`'s own internal `readCache` call hits that SAME fake
 * on a miss — so a caller cannot tell "the peek-and-meter block ran and then fell through to
 * `resolveDistance`" from "the block was deleted outright and `resolveDistance` ran unguarded".
 * This is for the tests that need exactly that distinction (Finding 3, fix wave 2).
 */
function fakeLookupDeps(outcome: DistanceOutcome = { status: 'failed' }): {
  deps: DistanceDeps
  lookupCalls: () => number
} {
  let calls = 0
  const deps: DistanceDeps = {
    lookup: async () => {
      calls++
      return outcome
    },
    readCache: sqlDistanceCache.readCache,
    writeCache: sqlDistanceCache.writeCache,
  }
  return { deps, lookupCalls: () => calls }
}

describe('POST /api/orders', () => {
  let shop: string
  let pendingShop: string
  let suspendedShop: string
  let productId: string
  let customerToken: string
  let strangerToken: string
  let racerTokens: string[]
  let customerId: string
  let strangerId: string

  beforeAll(async () => {
    const owner = await makeUser('ord-owner@test.dev', 'password123')
    const otherOwner = await makeUser('ord-other-owner@test.dev', 'password123')
    const thirdOwner = await makeUser('ord-third-owner@test.dev', 'password123')
    const customer = await makeUser('ord-customer@test.dev', 'password123')
    const stranger = await makeUser('ord-stranger@test.dev', 'password123')

    const ownerId = (await owner.auth.getUser()).data.user!.id
    const otherOwnerId = (await otherOwner.auth.getUser()).data.user!.id
    const thirdOwnerId = (await thirdOwner.auth.getUser()).data.user!.id
    customerId = (await customer.auth.getUser()).data.user!.id
    strangerId = (await stranger.auth.getUser()).data.user!.id
    customerToken = (await customer.auth.getSession()).data.session!.access_token
    strangerToken = (await stranger.auth.getSession()).data.session!.access_token

    // Six DISTINCT accounts for the cap-under-load case. The one-per-customer key is now the
    // token's email, so six racers sharing one token would collide on `voucher_already_used`
    // and never reach the cap at all — the very thing that test exists to prove. Sequential,
    // not Promise.all: makeUser lists-then-deletes by email, and six of those racing each
    // other is a fixture bug waiting to happen.
    racerTokens = []
    for (let i = 0; i < 6; i++) {
      const racer = await makeUser(`ord-racer${i}@test.dev`, 'password123')
      racerTokens.push((await racer.auth.getSession()).data.session!.access_token)
    }

    // Each shop gets its OWN owner: current_merchant_id() resolves one shop per owner, and
    // that invariant is now a unique index on merchants(owner_id) — piling more than one
    // shop onto an owner is a state the app cannot represent and the DB now refuses.
    shop = await seedMerchant({ slug: 'ord-shop', order_prefix: 'OR', owner_id: ownerId })
    pendingShop = await seedMerchant({ slug: 'ord-pending', order_prefix: 'OP', owner_id: otherOwnerId, status: 'pending' })
    suspendedShop = await seedMerchant({ slug: 'ord-suspended', order_prefix: 'OS', owner_id: thirdOwnerId, status: 'suspended' })
  }, 60_000)

  // Each test starts from an empty shop: the counter is per-merchant and per-day, so a
  // leftover row from the previous test would make the expected order number depend on
  // execution order. The product is reseeded per test, not per suite, because one of the
  // price-authority cases moves its price out from under a quote.
  beforeEach(async () => {
    await svc().from('orders').delete().eq('merchant_id', shop)
    await svc().from('order_counters').delete().eq('merchant_id', shop)
    await svc().from('vouchers').delete().eq('merchant_id', shop)
    await svc().from('products').delete().eq('merchant_id', shop)
    productId = await seedProduct({ merchant_id: shop, price: 13 })
    // Reset the shop's fulfilment config to default, so mutations in one test (e.g.,
    // the closed-weekday case below) don't leak to others.
    await setFulfilmentConfig(shop, { lead_days: 0, window_days: 14, closed_weekdays: [] })
  })

  afterAll(async () => {
    for (const slug of SLUGS) await resetMerchant(slug)
  })

  // ── The happy path, and the format that must not move ───────────────────────

  it('places an order and returns its number', async () => {
    const res = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone() }))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ orderNumber: `OR-${DAY}-0050` })
  })

  it('writes the order row, with the cart and the total', async () => {
    await post(body(shop, productId, { fulfilDate: tomorrowInShopZone() }))
    const [order] = await ordersOf(shop)

    expect(order).toMatchObject({
      order_number: `OR-${DAY}-0050`,
      customer_name: 'Ah Meng',
      customer_wa: '60123456789',
      mode: 'pickup',
      status: 'new',
      total: 26,
      currency: 'MYR',
    })
  })

  // The counter starts at 50, not 1 — inherited from next_order_number and customer-visible.
  it('starts a shop’s day at 0050 and increments from there', async () => {
    const first = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone() }))
    const second = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone() }))

    expect(await first.json()).toEqual({ orderNumber: `OR-${DAY}-0050` })
    expect(await second.json()).toEqual({ orderNumber: `OR-${DAY}-0051` })
  })

  // ── The intake gate, now a TypeScript invariant (db.ts bypasses RLS) ───────

  it('refuses an order against a pending shop, and writes nothing', async () => {
    const res = await post(body(pendingShop, productId, { fulfilDate: tomorrowInShopZone() }))

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'merchant_inactive' })
    expect(await ordersOf(pendingShop)).toEqual([])
    expect(await counterOf(pendingShop)).toBeNull()
  })

  it('refuses an order against a suspended shop, and writes nothing', async () => {
    const res = await post(body(suspendedShop, productId, { fulfilDate: tomorrowInShopZone() }))

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'merchant_inactive' })
    expect(await ordersOf(suspendedShop)).toEqual([])
  })

  // Finding 5 (fix wave 2): every other intake-gate case above uses `body()`, which is
  // `mode: 'pickup'` — so `resolveRoutedMetres` (the function whose whole job is to check
  // status BEFORE the Google spend, see its own comment) returns on its very first line and
  // never reaches that check at all. A regression that moved the check below the spend would
  // leave every test above still green.
  //
  // A first version of this test used `mode: 'delivery'` against the plain (non-express)
  // `suspendedShop` over HTTP — CONFIRMED BY EXPERIMENT (not reasoned) to be insufficient: with
  // the status check moved below the spend, `resolveRoutedMetres` still returns `null` at its
  // `input.mode !== 'express'` line (this order is not express) regardless of where the
  // status check sits relative to that, so the request proceeds into the transaction and
  // `assertOrderableMerchant`'s own status check — the authoritative backstop, kept
  // deliberately — throws the SAME `merchant_inactive` with the SAME HTTP shape. The response
  // alone cannot tell "refused before touching Google" from "refused after, by the backstop",
  // and the experiment (moving the check down, running that test) stayed green.
  //
  // So this needs a shop that IS distance-priced, so there is a real spend to be before-or-
  // after, and it needs to observe the spend directly rather than the HTTP shape —
  // `placeOrder` is called straight with an instrumented `DistanceDeps` (the same seam
  // `distance_lookup_failed and the injected DistanceDeps seam` below uses), so the assertion
  // is "the cache was never even peeked", not just "got a 409".
  describe('the status gate runs before any spend, on a distance-priced shop', () => {
    let suspendedDistanceId = ''
    let suspendedDistanceProductId = ''

    beforeAll(async () => {
      const owner = await makeUser('ord-distance-suspended-owner@test.dev', 'password123')
      const ownerId = (await owner.auth.getUser()).data.user!.id
      suspendedDistanceId = await seedMerchant({
        slug: 'ord-distance-suspended', owner_id: ownerId, order_prefix: 'DS', status: 'suspended',
        express_enabled: true, delivery_base_fee: 6, delivery_rate_per_km: 1,
        delivery_max_km: 30, origin_place_id: 'ChIJord-susp-origin',
      })
      suspendedDistanceProductId = await seedProduct({ merchant_id: suspendedDistanceId, price: 13 })
    }, 60_000)

    afterAll(() => resetMerchant('ord-distance-suspended'))

    it('refuses the order and never even peeks the distance cache', async () => {
      let peeked = false
      const deps: DistanceDeps = {
        lookup: async () => { throw new Error('lookup must never run — the shop is suspended') },
        readCache: async () => { peeked = true; return null },
        writeCache: async () => {},
      }

      let err: unknown
      try {
        await placeOrder(
          {
            merchantId: suspendedDistanceId,
            userId: null,
            userEmail: null,
            customerName: 'Ah Meng',
            customerWa: '60123456789',
            mode: 'express',
            address: { line1: '12 Jalan Test', postcode: '50000', city: 'Kuala Lumpur', state: 'Selangor' },
            cart: { [suspendedDistanceProductId]: 2 },
            quotedTotal: 57.2,
            voucherCode: null,
            fulfilDate: todayInZone(DEFAULT_TIMEZONE, new Date()),
            destinationPlaceId: 'ChIJord-susp-dest',
          },
          new Date(),
          deps,
        )
      } catch (e) {
        err = e
      }

      expect(err).toBeInstanceOf(OrderError)
      expect((err as OrderError).code).toBe('merchant_inactive')
      // The behavioural proof: NOT ONE byte was spent chasing a route for a shop that cannot
      // take the order at all.
      expect(peeked).toBe(false)
    })
  })

  it('refuses an order against a merchant that does not exist', async () => {
    const res = await post(body('00000000-0000-0000-0000-000000000000', productId, { fulfilDate: tomorrowInShopZone() }))

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'merchant_not_found' })
  })

  // The insert policy used to enforce this. It no longer runs on the backend's connection,
  // so the endpoint has to — a client must not be able to file an already-completed order.
  it('never persists a status the client asked for', async () => {
    await post(body(shop, productId, { fulfilDate: tomorrowInShopZone(), status: 'done' }))
    const [order] = await ordersOf(shop)

    expect(order.status).toBe('new')
  })

  // A number field that is not a number is the CLIENT's bug. Coercing it (`Number('abc')` →
  // NaN) would push it all the way to Postgres and return a 500 — a bad request reported as a
  // server fault, and a lie in the logs when someone comes to debug it.
  it('rejects a malformed body rather than coercing it into a 500', async () => {
    const res = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone(), quotedTotal: 'abc' }))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_body' })
    expect(await ordersOf(shop)).toEqual([])
  })

  // The cart's SHAPE is validated at the door, and each of these is a 400 rather than a 500 or
  // a committed order. The quantity cases are the sharp ones: a non-numeric qty would reach
  // Postgres as NaN and come back a server fault, and a zero/negative one would leave a cart
  // that prices to nothing.
  describe('a cart that is not a cart is a bad request', () => {
    const cases: [string, unknown][] = [
      ['a non-integer quantity', 'abc'],
      ['a fractional quantity', 1.5],
      ['a negative quantity', -1],
      ['a zero quantity', 0],
    ]

    for (const [name, qty] of cases) {
      it(`rejects ${name}`, async () => {
        const res = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone(), cart: { [productId]: qty } }))

        expect(res.status).toBe(400)
        expect(await errorOf(res)).toBe('invalid_body')
        expect(await ordersOf(shop)).toEqual([])
      })
    }

    // `Number.isInteger(1e21)` is TRUE, and the quote check cannot save us: the client quotes
    // the same astronomical total it asked for, so the two agree and the order commits. The cap
    // is the only thing standing in front of it.
    it('rejects an absurd quantity', async () => {
      const res = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone(), cart: { [productId]: 1e21 }, quotedTotal: 13e21 }))

      expect(res.status).toBe(400)
      expect(await errorOf(res)).toBe('invalid_body')
      expect(await ordersOf(shop)).toEqual([])
    })

    // The caps come from @bitetime/shared, and the tests read them from there rather than
    // hardcoding 1001: the storefront stops the customer at the SAME number, and a cap that
    // could be raised in one workspace without this suite noticing is the drift the shared
    // module exists to prevent.
    it('rejects a quantity past the per-line cap', async () => {
      const qty = MAX_CART_QTY + 1
      const res = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone(), cart: { [productId]: qty }, quotedTotal: 13 * qty }))

      expect(res.status).toBe(400)
      expect(await errorOf(res)).toBe('invalid_body')
      expect(await ordersOf(shop)).toEqual([])
    })

    it('accepts a quantity exactly at the cap', async () => {
      const res = await post(body(shop, productId, {
        fulfilDate: tomorrowInShopZone(),
        cart: { [productId]: MAX_CART_QTY },
        quotedTotal: 13 * MAX_CART_QTY,
      }))

      expect(res.status).toBe(200)
      expect(await ordersOf(shop)).toHaveLength(1)
    })

    it('rejects a cart with more distinct lines than the cap', async () => {
      // The ids need not exist: the shape is refused at the door, before anything is looked up.
      const cart = Object.fromEntries(
        Array.from({ length: MAX_CART_LINES + 1 }, (_, i) => [
          `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`, 1,
        ]),
      )
      const res = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone(), cart }))

      expect(res.status).toBe(400)
      expect(await errorOf(res)).toBe('invalid_body')
      expect(await ordersOf(shop)).toEqual([])
    })

    it('rejects an empty cart', async () => {
      const res = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone(), cart: {} }))

      expect(res.status).toBe(400)
      expect(await errorOf(res)).toBe('invalid_body')
      expect(await ordersOf(shop)).toEqual([])
    })

    // An array has no ids at all — `Object.values([])` is empty, so a laxer check would call
    // it valid and hand cartProducts a cart with nothing in it.
    it('rejects a cart sent as an array', async () => {
      const res = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone(), cart: [] }))

      expect(res.status).toBe(400)
      expect(await errorOf(res)).toBe('invalid_body')
      expect(await ordersOf(shop)).toEqual([])
    })
  })

  // `mode` SELECTS THE SHIPPING FEE — only 'delivery' reads the shop's rates, so any other
  // value prices shipping at 0. It was validated as a bare string, which meant
  // `{ mode: 'sameday', address: {…} }` bought a delivery for free, and `mode: 'banana'`
  // committed garbage into a text column with no check constraint. It is an allowlist now.
  describe('mode is an allowlist, because it picks the shipping fee', () => {
    for (const mode of ['sameday', 'banana', '', 'DELIVERY']) {
      it(`refuses mode ${JSON.stringify(mode)}, and writes nothing`, async () => {
        const res = await post(body(shop, productId, {
          fulfilDate: tomorrowInShopZone(),
          mode,
          address: { line1: '1 Jalan Besar', postcode: '88000', city: 'Kota Kinabalu', state: 'Sabah' },
        }))

        expect(res.status).toBe(400)
        expect(await errorOf(res)).toBe('invalid_body')
        expect(await ordersOf(shop)).toEqual([])
      })
    }
  })

  // ── Attribution: the JWT decides, the body never does ───────────────────────

  it('attributes a signed-in customer’s order to them', async () => {
    await post(body(shop, productId, { fulfilDate: tomorrowInShopZone() }), customerToken)
    const [order] = await ordersOf(shop)

    expect(order.user_id).toBe(customerId)
  })

  it('leaves a guest’s order unattributed', async () => {
    await post(body(shop, productId, { fulfilDate: tomorrowInShopZone() }))
    const [order] = await ordersOf(shop)

    expect(order.user_id).toBeNull()
  })

  // The spoofing hole the orders_set_user_id trigger was written to close. The trigger now
  // coalesces rather than overwrites — safe ONLY because anon/authenticated lost INSERT, so
  // anything reaching it with a settable user_id is this backend. The endpoint must therefore
  // never take user_id from the body, and these two tests are what hold that line.
  it('ignores a user_id in a guest’s body — a guest cannot attribute an order to anyone', async () => {
    await post(body(shop, productId, { fulfilDate: tomorrowInShopZone(), user_id: strangerId, userId: strangerId }))
    const [order] = await ordersOf(shop)

    expect(order.user_id).toBeNull()
  })

  it('ignores a stranger’s user_id in a signed-in customer’s body', async () => {
    await post(body(shop, productId, { fulfilDate: tomorrowInShopZone(), user_id: strangerId, userId: strangerId }), customerToken)
    const [order] = await ordersOf(shop)

    expect(order.user_id).toBe(customerId)
  })

  // ── Vouchers: the claim commits with the order, or not at all ───────────────
  //
  // Every case here signs in. A voucher REQUIRES AN ACCOUNT (#72): the one-per-customer key is
  // the token's verified email and nothing else, so a voucher case run as a guest is no longer
  // a voucher case — it is the refusal below. The assertions are unchanged; only who is
  // holding the code has moved from a body field to a JWT.

  it('claims the voucher and records the order’s discount', async () => {
    await seedVoucher(shop, 'SAVE5', null)

    const res = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone(), quotedTotal: 21, voucherCode: 'SAVE5' }), customerToken)

    expect(res.status).toBe(200)
    const [order] = await ordersOf(shop)
    expect(order).toMatchObject({ discount: 5, voucher_code: 'SAVE5', total: 21 })
    expect((await voucherOf(shop, 'SAVE5'))!.used_by).toEqual(['ord-customer@test.dev'])
  })

  it('rejects a voucher code that does not exist', async () => {
    const res = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone(), quotedTotal: 21, voucherCode: 'NOPE' }), customerToken)

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'voucher_not_found' })
  })

  it('rejects a voucher this customer already used', async () => {
    await seedVoucher(shop, 'SAVE5', null)
    await post(body(shop, productId, { fulfilDate: tomorrowInShopZone(), quotedTotal: 21, voucherCode: 'SAVE5' }), customerToken)

    const res = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone(), quotedTotal: 21, voucherCode: 'SAVE5' }), customerToken)

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'voucher_already_used' })
  })

  // Two DIFFERENT accounts, or the second would be refused one-per-customer and never reach
  // the cap. The cap is a property of the voucher; `voucher_already_used` is a property of the
  // person, and this test is about the former.
  it('rejects a voucher that has hit its cap', async () => {
    await seedVoucher(shop, 'CAP1', 1)
    await post(body(shop, productId, { fulfilDate: tomorrowInShopZone(), quotedTotal: 21, voucherCode: 'CAP1' }), customerToken)

    const res = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone(), quotedTotal: 21, voucherCode: 'CAP1' }), strangerToken)

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'voucher_fully_used' })
  })

  // THE BUG THIS TICKET EXISTS TO KILL. Before, the order was already committed by the time
  // the redemption failed — so the customer kept a discount on a voucher never marked used.
  it('rolls the whole order back when the voucher claim fails — no row, no burnt counter', async () => {
    const res = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone(), quotedTotal: 21, voucherCode: 'NOPE' }), customerToken)

    expect(res.status).toBe(409)
    // WHICH refusal, and not merely that there was one. Signed in, with a code that does not
    // exist: the CLAIM is what must fail. Without this, a regression that turned every voucher
    // into `voucher_requires_account` would leave this green under a name saying otherwise —
    // same consequence (409, nothing written), entirely different reason.
    expect(await errorOf(res)).toBe('voucher_not_found')
    expect(await ordersOf(shop)).toEqual([])
    // The counter slot must not survive the rollback either, or order numbers develop gaps
    // that nobody can explain.
    expect(await counterOf(shop)).toBeNull()
  })

  // The OTHER direction, and the one that actually costs money. Above, the claim failed before
  // anything was written — cheap to roll back. Here the voucher IS claimed and the counter IS
  // bumped, and then the INSERT fails: this is the only path where a committed redemption
  // could survive an order that never existed, handing the customer a spent voucher and no
  // order. Forced with a real constraint (the partial unique index on merchant_id +
  // order_number) by parking an order on the number this intake is about to generate.
  it('rolls back a claimed voucher and a bumped counter when the insert itself fails', async () => {
    await seedVoucher(shop, 'SAVE5', null)
    const { error } = await svc()
      .from('orders')
      .insert({ merchant_id: shop, order_number: `OR-${DAY}-0050`, status: 'new', total: 1 })
    expect(error).toBeNull()

    const res = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone(), quotedTotal: 21, voucherCode: 'SAVE5' }), customerToken)

    // Not a domain refusal — the customer did nothing wrong, so this is a 500, not a 409.
    expect(res.status).toBe(500)
    // The voucher survived unspent...
    expect((await voucherOf(shop, 'SAVE5'))!.used_by).toEqual([])
    // ...the counter was not burned...
    expect(await counterOf(shop)).toBeNull()
    // ...and no second order landed.
    expect(await ordersOf(shop)).toHaveLength(1)
  })

  it('lets the customer retry without the voucher, and that order succeeds', async () => {
    const failed = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone(), quotedTotal: 21, voucherCode: 'NOPE' }), customerToken)
    expect(failed.status).toBe(409)
    // The retry is only interesting after a failed CLAIM. Assert the code, or this test also
    // passes when the voucher was refused for having no account at all — a different story.
    expect(await errorOf(failed)).toBe('voucher_not_found')

    const retry = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone() }), customerToken)

    expect(retry.status).toBe(200)
    // The failed attempt burned nothing: this is still the day's FIRST order.
    expect(await retry.json()).toEqual({ orderNumber: `OR-${DAY}-0050` })
  })

  // ── The one-per-customer key comes from the JWT and from nowhere else (#72) ──
  //
  // `voucherEntry` was the key AND a field the body supplied, so the same person re-redeemed a
  // one-per-customer voucher forever just by varying it — and against a null `max_uses`
  // ("unlimited in total, still 1/customer") that was an unlimited discount for one person.

  describe('a voucher claim is keyed to a verified account', () => {
    it('refuses a voucher from a guest, and writes nothing', async () => {
      await seedVoucher(shop, 'SAVE5', null)

      const res = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone(), voucherCode: 'SAVE5', quotedTotal: 21 }))
      expect(res.status).toBe(409)
      expect(await errorOf(res)).toBe('voucher_requires_account')
      expect(await ordersOf(shop)).toHaveLength(0)
      // Refused BEFORE the claim: the voucher must not be burnt by an order that never existed.
      expect((await voucherOf(shop, 'SAVE5'))!.used_by).toEqual([])
    })

    it('keys used_by on the token email, not on anything the body said', async () => {
      await seedVoucher(shop, 'SAVE5', null)

      const res = await post(
        // The body still tries to name its own key. It must be IGNORED, not honoured — the
        // direct analogue of the suite's "never persists a status the client asked for".
        body(shop, productId, { fulfilDate: tomorrowInShopZone(), voucherCode: 'SAVE5', voucherEntry: 'someone@else.com', quotedTotal: 21 }),
        customerToken,
      )
      expect(res.status).toBe(200)

      expect((await voucherOf(shop, 'SAVE5'))!.used_by).toEqual(['ord-customer@test.dev'])
    })

    it('cannot be redeemed twice by the same account — the hole itself', async () => {
      await seedVoucher(shop, 'SAVE5', null)

      const first = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone(), voucherCode: 'SAVE5', quotedTotal: 21 }), customerToken)
      expect(first.status).toBe(200)

      // Before the fix this succeeded by simply varying `voucherEntry`. Now the body carries no
      // key at all, so the attack cannot even be EXPRESSED — which is the point.
      const second = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone(), voucherCode: 'SAVE5', quotedTotal: 21 }), customerToken)
      expect(second.status).toBe(409)
      expect(await errorOf(second)).toBe('voucher_already_used')

      expect(await ordersOf(shop)).toHaveLength(1)
      expect((await voucherOf(shop, 'SAVE5'))!.used_by).toEqual(['ord-customer@test.dev'])
    })
  })

  // ── Concurrency. Real row locks, real Postgres — the point of the driver ────

  it('gives two concurrent orders distinct order numbers', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => post(body(shop, productId, { fulfilDate: tomorrowInShopZone() }))))
    const numbers = await Promise.all(results.map(r => r.json() as Promise<{ orderNumber: string }>))

    const distinct = new Set(numbers.map(n => n.orderNumber))
    expect(distinct.size).toBe(8)
    expect(results.every(r => r.status === 200)).toBe(true)
  })

  // The same account, twice, at once — which is what a double-tapped checkout button IS. The
  // loser must read the winner's write through the row lock, not the stale row.
  it('lets exactly one of two concurrent orders redeem a single-use voucher', async () => {
    await seedVoucher(shop, 'ONCE', 1)
    const one = () => post(body(shop, productId, { fulfilDate: tomorrowInShopZone(), quotedTotal: 21, voucherCode: 'ONCE' }), customerToken)

    const [a, b] = await Promise.all([one(), one()])
    const statuses = [a.status, b.status].sort()

    expect(statuses).toEqual([200, 409])
    const loser = a.status === 409 ? a : b
    expect(await loser.json()).toEqual({ error: 'voucher_already_used' })
    expect((await voucherOf(shop, 'ONCE'))!.used_by).toEqual(['ord-customer@test.dev'])
    expect(await ordersOf(shop)).toHaveLength(1)
  })

  // A fifty-use voucher redeemed five hundred times is the merchant's solvency. The cap has
  // to hold when the redemptions arrive at once — six racers against a cap of two: two commit,
  // four are refused, and the voucher ends with exactly two names on it.
  //
  // WHAT THIS TEST DOES NOT PROVE — and its comment used to claim it did — is that the
  // voucher's `select … for update` is what holds that cap. Every intake takes the COUNTER row
  // FIRST: `nextCounterValue`'s `insert … on conflict (merchant_id) do update` is an exclusive
  // lock on the shop's single counter row, held until commit. All six transactions therefore
  // serialize on the counter BEFORE any of them reaches the voucher, and under READ COMMITTED
  // each one's voucher SELECT re-reads the previous committer's `used_by` anyway. Delete the
  // `for update` and this very likely still passes. The counter row is the real serializer for
  // same-merchant intake; the voucher lock is defence-in-depth behind it, and it is what would
  // hold a claim that ever stops going through the counter. Keep it.
  //
  // Nor can it be isolated from here: the voucher row and the counter row are both keyed by
  // merchant, so there is no concurrent claim on one voucher that is not also a concurrent bump
  // of one counter. Watching the lock alone would mean driving `claimVoucher` directly — it is
  // private to orders.ts, and prising that open buys a test of a lock nothing can currently
  // reach unserialized.
  //
  // Six DIFFERENT accounts, one token each, because the CAP is what must stop the last four.
  // Six racers behind ONE token would be stopped by one-per-customer (`voucher_already_used`)
  // long before the cap — and this test would then go RED, not quietly green: `ok` would be 1.
  it('holds a voucher’s cap under concurrent load', async () => {
    await seedVoucher(shop, 'CAP2', 2)
    const attempts = racerTokens.map(token =>
      post(body(shop, productId, { fulfilDate: tomorrowInShopZone(), quotedTotal: 21, voucherCode: 'CAP2' }), token),
    )

    const results = await Promise.all(attempts)
    const ok = results.filter(r => r.status === 200)
    const rejected = results.filter(r => r.status === 409)

    expect(ok).toHaveLength(2)
    expect(rejected).toHaveLength(4)
    // WHICH refusal, not merely how many. The fixture now turns on account identity: two racer
    // tokens accidentally minted for the same email would give 3 × fully_used + 1 ×
    // already_used — still four rejects, still green, and testing one-per-customer instead of
    // the cap. The cap is the only thing allowed to stop these four.
    expect(await Promise.all(rejected.map(errorOf))).toEqual(Array(4).fill('voucher_fully_used'))
    expect((await voucherOf(shop, 'CAP2'))!.used_by).toHaveLength(2)
    // Only the two that redeemed it left an order behind — the other four rolled back whole.
    expect(await ordersOf(shop)).toHaveLength(2)
  })

  describe('the backend is the price authority', () => {
    it('refuses a body that names its own total, and writes nothing', async () => {
      // THE HOLE THIS TASK CLOSES. Before it, this committed an order at zero.
      const res = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone(), quotedTotal: 0 }))
      expect(res.status).toBe(409)
      expect(await errorOf(res)).toBe('price_changed')
      expect(await ordersOf(shop)).toHaveLength(0)
    })

    // The body states every price it can, and none of them survive. Same shape as `never
    // persists a status the client asked for`: the hostile value is SENT, and the committed
    // row is what proves it was ignored rather than merely absent.
    it('commits the server-derived total and items, not anything the body said', async () => {
      const res = await post(body(shop, productId, {
        fulfilDate: tomorrowInShopZone(),
        items: [{ id: 'x', name: 'Free Ferrari', qty: 1, price: 0 }],
        total: 0,
        shippingFee: -50,
        shipping_fee: -50,
        discount: 999,
        currency: 'USD',
      }))
      expect(res.status).toBe(200)

      const [order] = await ordersOf(shop)
      expect(Number(order.total)).toBe(26)
      expect(Number(order.shipping_fee)).toBe(0)
      // No voucher was claimed, so there is no discount — 999 is not a number the body gets to
      // hand itself, and the currency is the shop's.
      expect(order.discount).toBeNull()
      expect(order.currency).toBe('MYR')
      // Built from the products rows, so the name and the unit price are the shop's own — not
      // whatever the browser felt like calling them. `promo: false` — this product has none.
      expect(order.items).toEqual([
        { id: productId, name: 'Matcha Cookie', qty: 2, price: 13, promo: false },
      ])
    })

    it('refuses with price_changed when the price moves between quote and submit', async () => {
      await svc().from('products').update({ price: 15 }).eq('id', productId)

      const res = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone() }))  // still quoting the old 26
      expect(res.status).toBe(409)
      expect(await errorOf(res)).toBe('price_changed')
      expect(await ordersOf(shop)).toHaveLength(0)
      // Rolled back WHOLE: not even a burnt counter slot.
      expect(await counterOf(shop)).toBeNull()
    })

    it("refuses a product belonging to another shop", async () => {
      // The order goes to `shop`, which is active and orderable; the product is `suspendedShop`'s.
      // Nothing but the merchant_id predicate in cartProducts stands between them — db.ts is
      // RLS-exempt, so this is the test that the TypeScript invariant actually holds.
      const strangersProduct = await seedProduct({ merchant_id: suspendedShop, price: 13 })

      const res = await post(body(shop, strangersProduct, { fulfilDate: tomorrowInShopZone() }))
      expect(res.status).toBe(409)
      expect(await errorOf(res)).toBe('product_unavailable')
      expect(await ordersOf(shop)).toHaveLength(0)
    })

    it('refuses a product that is not active', async () => {
      const hidden = await seedProduct({ merchant_id: shop, price: 13, active: false })

      const res = await post(body(shop, hidden, { fulfilDate: tomorrowInShopZone() }))
      expect(res.status).toBe(409)
      expect(await errorOf(res)).toBe('product_unavailable')
      expect(await ordersOf(shop)).toHaveLength(0)
    })

    it('refuses a cart id that is not a product id, as a refusal and not a 500', async () => {
      const res = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone(), cart: { 'not-a-uuid': 1 } }))
      expect(res.status).toBe(409)
      expect(await errorOf(res)).toBe('product_unavailable')
    })

    // A LIVE FREE-ORDER HOLE. Postgres matches `uuid` case-insensitively, so an UPPERCASE cart
    // key sails past both `= any(${ids}::uuid[])` and the "every id came back" refusal — but
    // `priceOrder` finds a line by `products.find(p => p.id === id)`, a JS `===` that never
    // matches an uppercase key against the lowercase id postgres.js hands back. The line was
    // silently DROPPED, pricing the whole cart at zero; on a pickup there is no shipping fee left
    // to give it away, so `quotedTotal: 0` agreed with the derived total and committed. Proved
    // against a running stack before the fix: this exact request returned 200 with an order at
    // total 0. The fix is the regex's missing `i` — see the UUID const in orders.ts.
    it('refuses an uppercase-uuid cart key instead of silently pricing the order at zero', async () => {
      const res = await post(body(shop, productId, {
        fulfilDate: tomorrowInShopZone(),
        cart: { [productId.toUpperCase()]: 2 },
        quotedTotal: 0,
      }))

      expect(res.status).toBe(409)
      expect(await errorOf(res)).toBe('product_unavailable')
      // Not just the status code — the stored rows. A regression that dropped the line and then
      // refused for some OTHER reason would leave a committed order behind the moment that other
      // reason stopped firing.
      expect(await ordersOf(shop)).toEqual([])
      expect(await counterOf(shop)).toBeNull()
    })

    it('derives the shipping fee from the shop rates and the delivery region', async () => {
      await svc().from('merchants').update({ shipping: { WM: 8, EM: 18 } }).eq('id', shop)

      const res = await post(body(shop, productId, {
        fulfilDate: tomorrowInShopZone(),
        mode: 'delivery',
        address: { line1: '1 Jalan Besar', postcode: '88000', city: 'Kota Kinabalu', state: 'Sabah' },
        quotedTotal: 44,   // 26 + EM 18
      }))
      expect(res.status).toBe(200)

      const [order] = await ordersOf(shop)
      expect(Number(order.shipping_fee)).toBe(18)
      expect(Number(order.total)).toBe(44)
    })

    // The `mode` allowlist's hole, one field over. `shippingFee` reads the REGION off
    // `address.state`; with no state it falls through to `return 0` — so a perfectly deliverable
    // address with the state left out committed a delivery to Sabah at shipping_fee = 0, and the
    // quote check waved it through because the client quoted the same zero. Nothing else refuses
    // it: `mode` is valid, the address is present, the products are real.
    describe('a delivery must say where it is going', () => {
      const deliverable = { line1: '1 Jalan Besar', postcode: '88000', city: 'Kota Kinabalu' }

      const cases: [string, unknown][] = [
        ['no state key at all', deliverable],
        ['an empty state', { ...deliverable, state: '' }],
        ['a non-string state', { ...deliverable, state: 42 }],
        ['no address at all', undefined],
      ]

      for (const [name, address] of cases) {
        it(`refuses a delivery with ${name}, and writes nothing`, async () => {
          const res = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone(), mode: 'delivery', address, quotedTotal: 26 }))

          expect(res.status).toBe(409)
          expect(await errorOf(res)).toBe('delivery_state_required')
          expect(await ordersOf(shop)).toEqual([])
          // Rolled back whole — not even a counter slot burnt.
          expect(await counterOf(shop)).toBeNull()
        })
      }

      // The refusal is about the DELIVERY, not about the address: a pickup has nowhere to ship
      // to and must keep working with no address at all.
      it('still takes a pickup with no address', async () => {
        const res = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone() }))

        expect(res.status).toBe(200)
        const [order] = await ordersOf(shop)
        expect(Number(order.shipping_fee)).toBe(0)
      })
    })

    it('derives the voucher discount, and records it against the order', async () => {
      await svc().from('vouchers').insert({
        merchant_id: shop, code: 'SAVE10', kind: 'percent', amount: 10, used_by: [],
      })

      const res = await post(body(shop, productId, {
        fulfilDate: tomorrowInShopZone(),
        voucherCode: 'SAVE10',
        quotedTotal: 23.4,   // 26 − 10%
      }), customerToken)
      expect(res.status).toBe(200)

      const [order] = await ordersOf(shop)
      expect(Number(order.discount)).toBe(2.6)
      expect(Number(order.total)).toBe(23.4)
      expect(order.voucher_code).toBe('SAVE10')
    })
  })

  // ── Promo pricing: the backend prices and CLAIMS units under the row lock ────
  //
  // `promo_sold` is the counter the browser cannot move (products_promo_sold_guard,
  // #69) — these tests are the other half: proving the backend's own claim actually
  // advances it, and that the cap really binds a unit at a time under concurrency.
  describe('promo pricing', () => {
    it('commits at the promo price and moves the counter', async () => {
      const promoProductId = await seedPromoProduct(shop, { price: 10, promoPrice: 8 })

      const res = await post(body(shop, promoProductId, { fulfilDate: tomorrowInShopZone(), cart: { [promoProductId]: 2 }, quotedTotal: 16 }))

      expect(res.status).toBe(200)
      const [order] = await ordersOf(shop)
      expect(Number(order.total)).toBe(16)
      // `promo: true` rides along (I-2, #69 final review) so the STORED record explains the
      // split after the fact, not just the in-memory breakdown the success screen reads.
      expect(order.items).toEqual([{ id: promoProductId, name: 'Matcha Cookie', qty: 2, price: 8, promo: true }])
      expect((await productOf(promoProductId))!.promo_sold).toBe(2)
    })

    // THE CAP BINDS PER UNIT. A cart of 5 against 3 remaining is 3 + 2, not all-or-nothing —
    // two entries sharing one product id, at two different prices.
    it('the Nth+1 unit does not get the promo price', async () => {
      const promoProductId = await seedPromoProduct(shop, { price: 10, promoPrice: 8, promoLimit: 3, promoSold: 0 })

      const res = await post(body(shop, promoProductId, {
        fulfilDate: tomorrowInShopZone(),
        cart: { [promoProductId]: 5 },
        quotedTotal: 3 * 8 + 2 * 10,
      }))

      expect(res.status).toBe(200)
      const [order] = await ordersOf(shop)
      // Both halves of the split carry their own `promo` flag (I-2) — the two entries share a
      // product id and would otherwise be indistinguishable to anything reading the stored row.
      expect(order.items).toEqual([
        { id: promoProductId, name: 'Matcha Cookie', qty: 3, price: 8, promo: true },
        { id: promoProductId, name: 'Matcha Cookie', qty: 2, price: 10, promo: false },
      ])
      expect((await productOf(promoProductId))!.promo_sold).toBe(3)
    })

    // I-2 (#69 final review): before this fix, `orders.ts` dropped `PriceLine.promo` when
    // mapping to the stored `items` — the split was priced correctly but UNEXPLAINABLE
    // afterwards, because nothing on the row said which half was which. Assert it directly
    // against the real stored jsonb, not just against the in-memory breakdown the success
    // screen reads.
    it('stores the promo flag on each line, so the split is explainable after the fact', async () => {
      const promoProductId = await seedPromoProduct(shop, { price: 10, promoPrice: 8, promoLimit: 3, promoSold: 0 })
      const normalProductId = await seedProduct({ merchant_id: shop, price: 5 })

      const res = await post(body(shop, promoProductId, {
        fulfilDate: tomorrowInShopZone(),
        cart: { [promoProductId]: 3, [normalProductId]: 1 },
        quotedTotal: 3 * 8 + 5,
      }))

      expect(res.status).toBe(200)
      const [order] = await ordersOf(shop)
      expect(order.items).toEqual([
        { id: promoProductId, name: 'Matcha Cookie', qty: 3, price: 8, promo: true },
        { id: normalProductId, name: expect.any(String), qty: 1, price: 5, promo: false },
      ])
    })

    // THE ACCEPTANCE CRITERION. Modeled on 'holds a voucher's cap under concurrent load' above,
    // and the same caveat applies: every intake takes the merchant's single `order_counters` row
    // FIRST, so these two racers serialize on THAT lock before either ever reaches the product
    // row's `for update`. A green result here does not, by itself, prove the product lock works
    // — it proves the cap holds under the counter's serialization, which is the only concurrency
    // this merchant's intake can ever actually present. The product-row `for update` is what
    // would still hold the line if that stopped being true (a claim path that did not share the
    // counter). Kept for the same reason the voucher test is kept: real Postgres, real locks.
    it('two checkouts race the last promo unit and exactly one wins', async () => {
      const promoProductId = await seedPromoProduct(shop, { price: 10, promoPrice: 8, promoLimit: 1, promoSold: 0 })
      const one = () => post(body(shop, promoProductId, { fulfilDate: tomorrowInShopZone(), cart: { [promoProductId]: 1 }, quotedTotal: 8 }))

      const [a, b] = await Promise.all([one(), one()])
      const statuses = [a.status, b.status].sort()

      // price_changed is a 409 in this API (see 'the backend is the price authority' above),
      // never a new code — the wire contract does not move for a promo that sold out either.
      expect(statuses).toEqual([200, 409])
      const loser = a.status === 409 ? a : b
      expect(await errorOf(loser)).toBe('price_changed')
      expect((await productOf(promoProductId))!.promo_sold).toBe(1)
      expect(await ordersOf(shop)).toHaveLength(1)
    })

    // THE TEST THAT ACTUALLY ISOLATES THE PRODUCT ROW LOCK. The test above does NOT: both of
    // its racers are full intakes, and every intake takes the merchant's single
    // `order_counters` row FIRST, so two concurrent intakes always serialize there and never
    // contend on the product row — that test proves the cap holds end-to-end, nothing about
    // `for update` specifically. Verified by deleting `for update` from `cartProducts`'s
    // select: the full suite stayed green, including that test.
    //
    // This one holds the product row's lock from a SECOND, independent connection that never
    // touches `order_counters` at all, so there is no counter serialization to hide behind —
    // only the product row's own lock can make this discriminate. Confirmed both ways: with
    // `for update` this gets 409 `price_changed`; with it deleted, the intake's own
    // `promo_sold` update blocks until the holder commits and then reads a stale `before`,
    // tripping the "did not advance" guard and failing with a 500 `order_failed`.
    it('a second connection holding the last promo unit blocks the intake — proves the product lock, not the counter', async () => {
      const promoProductId = await seedPromoProduct(shop, { price: 10, promoPrice: 8, promoLimit: 1, promoSold: 0 })

      // A separate, independent postgres.js connection — NOT `withTransaction`/`sql` from
      // src/db.ts, which is the very connection under test. Closed in `finally` no matter what
      // happens below, so a failed assertion can never hang the suite or leak a connection.
      const other = postgres(env.databaseUrl, { max: 1 })
      let releaseHold: () => void = () => {}
      const held = new Promise<void>(resolve => { releaseHold = resolve })

      // Takes the last promo unit under an UNCOMMITTED transaction — a row lock the counter
      // mutex cannot see, let alone serialize against.
      const holder = other.begin(async tx => {
        await tx`update products set promo_sold = promo_sold + 1 where id = ${promoProductId}`
        await held // held open until the intake below is in flight against the locked row
      })

      try {
        // Give the holder's UPDATE time to actually take the row lock before the intake's own
        // `select ... for update` reaches for it — otherwise the two race each other and the
        // test passes or fails at random instead of proving anything.
        await new Promise(resolve => setTimeout(resolve, 100))

        // The intake quotes the promo price for a unit that is already spoken for.
        const resPromise = post(body(shop, promoProductId, { fulfilDate: tomorrowInShopZone(), cart: { [promoProductId]: 1 }, quotedTotal: 8 }))

        // Let the intake's select actually reach (and block on, if the lock is real) the row
        // before releasing the holder.
        await new Promise(resolve => setTimeout(resolve, 100))
        releaseHold()

        const [res] = await Promise.all([resPromise, holder])
        expect(res.status).toBe(409)
        expect(await errorOf(res)).toBe('price_changed')
      } finally {
        releaseHold()
        await holder.catch(() => {})
        await other.end()
      }
    })

    it('an elapsed promo does not apply', async () => {
      const past = new Date(Date.now() - 24 * 60 * 60_000).toISOString()
      const promoProductId = await seedPromoProduct(shop, { price: 10, promoPrice: 8, promoEnd: past })

      const stale = await post(body(shop, promoProductId, { fulfilDate: tomorrowInShopZone(), cart: { [promoProductId]: 1 }, quotedTotal: 8 }))
      expect(stale.status).toBe(409)
      expect(await errorOf(stale)).toBe('price_changed')

      const fresh = await post(body(shop, promoProductId, { fulfilDate: tomorrowInShopZone(), cart: { [promoProductId]: 1 }, quotedTotal: 10 }))
      expect(fresh.status).toBe(200)
      expect((await productOf(promoProductId))!.promo_sold).toBe(0)
    })
  })

  // ── Fulfilment date: judged against the shop's own window and clock (#91) ───
  //
  // Required as of Task 8: the storefront's picker (Task 6) sends one on every honest
  // checkout, so refusing a dateless order no longer closes checkout for anyone.
  describe('fulfilment date', () => {
    it('refuses an order with no fulfilment date, and writes nothing', async () => {
      const res = await post(body(shop, productId)) // carries no fulfilDate

      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'fulfil_date_required' })
      expect(await ordersOf(shop)).toEqual([])
      expect(await counterOf(shop)).toBeNull()
    })

    it('stores a fulfilment date the shop is taking orders for', async () => {
      const res = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone() }))

      expect(res.status).toBe(200)
      const [order] = await ordersOf(shop)
      expect(order.fulfil_date).not.toBeNull()
    })

    it('refuses a date past the end of the shop window, and writes nothing', async () => {
      const res = await post(body(shop, productId, { fulfilDate: '2099-01-01' }))

      expect(res.status).toBe(409)
      expect(await errorOf(res)).toBe('fulfil_date_unavailable')
      expect(await ordersOf(shop)).toEqual([])
      expect(await counterOf(shop)).toBeNull()
    })

    it('refuses a date on a weekday the shop is closed', async () => {
      // Shut the shop every day, so whatever date the helper picks is closed.
      await setFulfilmentConfig(shop, { lead_days: 0, window_days: 14, closed_weekdays: [0, 1, 2, 3, 4, 5, 6] })

      const res = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone() }))

      expect(res.status).toBe(409)
      expect(await errorOf(res)).toBe('fulfil_date_unavailable')
    })

    it('refuses a malformed date rather than storing it', async () => {
      const res = await post(body(shop, productId, { fulfilDate: 'next tuesday' }))

      expect(res.status).toBe(409)
      expect(await errorOf(res)).toBe('fulfil_date_unavailable')
    })
  })

  // ── Tax: derived inside the transaction, snapshotted with the rate that produced it (#88) ──
  //
  // Each case gets its own shop (seedMerchant, extended with tax_enabled/tax_rate — same
  // helper the rest of this suite seeds `shop`/`pendingShop`/`suspendedShop` from) rather than
  // mutating the shared `shop`: the shared one is reused by dozens of tests above that assume
  // tax is off, and flipping it under them would make this block's ordering load-bearing.
  describe('tax', () => {
    const TAX_SLUGS = ['ord-tax-a', 'ord-tax-b', 'ord-tax-c', 'ord-tax-d']

    afterAll(async () => {
      for (const slug of TAX_SLUGS) await resetMerchant(slug)
    })

    /** A fresh shop + one RM10 product, optionally taxed from birth. */
    async function makeTaxShop(slug: string, tax?: { tax_enabled: boolean; tax_rate: number }) {
      const owner = await makeUser(`${slug}-owner@test.dev`, 'password123')
      const ownerId = (await owner.auth.getUser()).data.user!.id
      const id = await seedMerchant({ slug, owner_id: ownerId, order_prefix: 'TX', ...(tax ?? {}) })
      const taxedProductId = await seedProduct({ merchant_id: id, price: 10 })
      return { id, productId: taxedProductId }
    }

    /** Flips a shop's tax settings after it already exists — the "merchant raised the rate mid-checkout" case. */
    async function setShopTax(merchantId: string, patch: { tax_enabled: boolean; tax_rate: number }) {
      const { error } = await svc().from('merchants').update(patch).eq('id', merchantId)
      if (error) throw new Error(`setting tax for ${merchantId}: ${error.message}`)
    }

    it('commits tax and the rate that produced it', async () => {
      const { id: taxShop, productId: taxProductId } = await makeTaxShop('ord-tax-a', { tax_enabled: true, tax_rate: 6 })

      const res = await post(body(taxShop, taxProductId, { fulfilDate: tomorrowInShopZone(), quotedTotal: 21.2 }))
      expect(res.status).toBe(200)

      const [order] = await ordersOf(taxShop)
      expect(Number(order.total)).toBe(21.2)
      expect(Number(order.tax)).toBe(1.2)
      expect(Number(order.tax_rate)).toBe(6)
    })

    it('commits zero tax for a shop that charges none', async () => {
      const { id: taxShop, productId: taxProductId } = await makeTaxShop('ord-tax-b')

      const res = await post(body(taxShop, taxProductId, { fulfilDate: tomorrowInShopZone(), quotedTotal: 20 }))
      expect(res.status).toBe(200)

      const [order] = await ordersOf(taxShop)
      expect(Number(order.tax)).toBe(0)
      expect(Number(order.tax_rate)).toBe(0)
    })

    it('refuses a quote computed before the merchant raised the rate', async () => {
      const { id: taxShop, productId: taxProductId } = await makeTaxShop('ord-tax-c', { tax_enabled: true, tax_rate: 6 })
      await setShopTax(taxShop, { tax_enabled: true, tax_rate: 8 })

      const res = await post(body(taxShop, taxProductId, { fulfilDate: tomorrowInShopZone(), quotedTotal: 21.2 }))
      expect(res.status).toBe(409)
      expect(await errorOf(res)).toBe('price_changed')
    })

    it('ignores a tax the client puts in the body', async () => {
      const { id: taxShop, productId: taxProductId } = await makeTaxShop('ord-tax-d', { tax_enabled: true, tax_rate: 6 })

      const res = await post(body(taxShop, taxProductId, {
        fulfilDate: tomorrowInShopZone(), quotedTotal: 21.2, tax: 0, tax_rate: 0,
      }))
      expect(res.status).toBe(200)

      const [order] = await ordersOf(taxShop)
      expect(Number(order.tax)).toBe(1.2)
      expect(Number(order.tax_rate)).toBe(6)
    })
  })

  // ── Fulfilment method gating (#103) ─────────────────────────────────────────
  //
  // Intake refuses a method the shop does not offer, and refuses it BEFORE the fee rules. The
  // flags live on the merchant row, which only the backend reads, so this is checked in the
  // transaction rather than at the route.
  describe('fulfilment method gating', () => {
    const METHOD_SLUGS = ['ord-pickup-only', 'ord-flat-only', 'ord-both']
    const BOTH_ORIGIN = 'ChIJord-both-origin'
    const BOTH_DEST = 'ChIJord-both-dest'
    let pickupOnlyId = '', pickupOnlyProduct = ''
    let flatOnlyId = '', flatOnlyProduct = ''
    let bothId = '', bothProduct = ''

    beforeAll(async () => {
      const mk = async (slug: string, flags: Record<string, unknown>) => {
        const owner = await makeUser(`${slug}-owner@test.dev`, 'password123')
        const ownerId = (await owner.auth.getUser()).data.user!.id
        const id = await seedMerchant({ slug, owner_id: ownerId, order_prefix: 'MG', ...flags })
        const pid = await seedProduct({ merchant_id: id, price: 13 })
        return { id, pid }
      }
      ;({ id: pickupOnlyId, pid: pickupOnlyProduct } =
        await mk('ord-pickup-only', { pickup_enabled: true, delivery_enabled: false, express_enabled: false }))
      ;({ id: flatOnlyId, pid: flatOnlyProduct } =
        await mk('ord-flat-only', { pickup_enabled: false, delivery_enabled: true, express_enabled: false }))
      ;({ id: bothId, pid: bothProduct } =
        await mk('ord-both', {
          pickup_enabled: false, delivery_enabled: true, express_enabled: true,
          delivery_base_fee: 6, delivery_rate_per_km: 1, delivery_max_km: 30,
          origin_place_id: BOTH_ORIGIN,
        }))
      await svc().from('distance_quotes').upsert({
        origin_place_id: BOTH_ORIGIN, destination_place_id: BOTH_DEST, metres: 25216,
        created_at: new Date().toISOString(),
      })
    }, 60_000)

    afterAll(async () => {
      for (const slug of METHOD_SLUGS) await resetMerchant(slug)
      const { error } = await svc().from('distance_quotes').delete().eq('origin_place_id', BOTH_ORIGIN)
      if (error) throw new Error(`cleaning up distance_quotes for ${BOTH_ORIGIN}: ${error.message}`)
    })

    it('refuses a method the shop does not offer', async () => {
      const res = await post(body(pickupOnlyId, pickupOnlyProduct, {
        fulfilDate: todayInZone(DEFAULT_TIMEZONE, new Date()), mode: 'delivery',
        address: { line1: '1 Jalan Test', postcode: '50000', city: 'KL', state: 'Selangor' }, quotedTotal: 34,
      }))
      expect(res.status).toBe(409)
      expect(await errorOf(res)).toBe('method_not_offered')
    })

    it('refuses express at a shop that only offers flat delivery', async () => {
      const res = await post(body(flatOnlyId, flatOnlyProduct, {
        fulfilDate: todayInZone(DEFAULT_TIMEZONE, new Date()), mode: 'express',
        address: { line1: '1 Jalan Test', postcode: '50000', city: 'KL', place_id: BOTH_DEST }, quotedTotal: 57.2,
      }))
      expect(res.status).toBe(409)
      expect(await errorOf(res)).toBe('method_not_offered')
    })

    it('stamps the distance snapshot on an express order, and leaves it null on a flat delivery at the same shop', async () => {
      // One shop, both methods live. The express order carries the distance line; the flat
      // delivery at the same shop carries none — a reader must never see 0 km where the answer
      // is "not priced by distance".
      const expressRes = await post(body(bothId, bothProduct, {
        fulfilDate: todayInZone(DEFAULT_TIMEZONE, new Date()), mode: 'express',
        address: { line1: '1 Jalan Test', postcode: '50000', city: 'KL', place_id: BOTH_DEST },
        quotedTotal: 57.2,   // 26 + (6 + 1 x 25.2)
      }))
      expect(expressRes.status).toBe(200)
      const expressNo = ((await expressRes.json()) as { orderNumber: string }).orderNumber
      const expressOrder = (await ordersOf(bothId)).find(o => o.order_number === expressNo)!
      expect(Number(expressOrder.delivery_distance_km)).toBe(25.2)
      expect(Number(expressOrder.delivery_base_fee)).toBe(6)
      expect(Number(expressOrder.delivery_rate_per_km)).toBe(1)

      const flatRes = await post(body(bothId, bothProduct, {
        fulfilDate: todayInZone(DEFAULT_TIMEZONE, new Date()), mode: 'delivery',
        address: { line1: '1 Jalan Test', postcode: '50000', city: 'KL', state: 'Selangor' },
        quotedTotal: 34,   // 26 + flat WM 8
      }))
      expect(flatRes.status).toBe(200)
      const flatNo = ((await flatRes.json()) as { orderNumber: string }).orderNumber
      const flatOrder = (await ordersOf(bothId)).find(o => o.order_number === flatNo)!
      expect(flatOrder.delivery_distance_km).toBeNull()
      expect(flatOrder.delivery_base_fee).toBeNull()
      expect(flatOrder.delivery_rate_per_km).toBeNull()
    })

    it('still refuses a flat delivery with no state', async () => {
      const res = await post(body(bothId, bothProduct, {
        fulfilDate: todayInZone(DEFAULT_TIMEZONE, new Date()), mode: 'delivery',
        address: { line1: '1 Jalan Test', postcode: '50000', city: 'KL' }, quotedTotal: 34,
      }))
      expect(res.status).toBe(409)
      expect(await errorOf(res)).toBe('delivery_state_required')
    })
  })

  // ── Distance-priced intake (#101 Task 7) ────────────────────────────────────
  //
  // A distance shop's fee is `base + rate x km`, and the km comes from a routed lookup the
  // customer's destination place id names — never from the request body. `distance_quotes` is
  // SEEDED here rather than hit over the network: it is the exact row order intake reads, and
  // it is what keeps this suite from calling Google at all (GOOGLE_MAPS_API_KEY is force-emptied
  // in vitest.db.config.ts).
  describe('distance-priced intake', () => {
    const ORIGIN = 'ChIJord-origin'
    const NEAR = 'ChIJord-near'
    const FAR = 'ChIJord-far'
    let distanceId = ''
    let distanceProductId = ''

    const deliveryBody = (extra: Record<string, unknown> = {}) => ({
      merchantId: distanceId,
      customerName: 'Ah Meng',
      customerWa: '60123456789',
      mode: 'express',
      address: { line1: '12 Jalan Test', unit: 'A-3-2', postcode: '50000', city: 'Kuala Lumpur', state: 'Selangor', place_id: NEAR },
      cart: { [distanceProductId]: 2 },
      // 2 x 13 = 26 subtotal, plus 6.00 + 1.00 x 25.2 = 31.20 shipping.
      quotedTotal: 57.2,
      fulfilDate: todayInZone(DEFAULT_TIMEZONE, new Date()),
      ...extra,
    })

    beforeAll(async () => {
      // Its own owner — merchants.owner_id is uniquely indexed, so the shared 'ord-owner' account
      // above cannot also own this shop.
      const owner = await makeUser('ord-distance-owner@test.dev', 'password123')
      const ownerId = (await owner.auth.getUser()).data.user!.id
      distanceId = await seedMerchant({
        slug: 'ord-distance', owner_id: ownerId, order_prefix: 'OD',
        express_enabled: true, delivery_base_fee: 6, delivery_rate_per_km: 1,
        delivery_max_km: 30, origin_place_id: ORIGIN,
      })
      distanceProductId = await seedProduct({ merchant_id: distanceId, price: 13 })
      for (const [dest, metres] of [[NEAR, 25216], [FAR, 45000]] as const) {
        await svc().from('distance_quotes').upsert({
          origin_place_id: ORIGIN, destination_place_id: dest, metres,
          created_at: new Date().toISOString(),
        })
      }
    }, 60_000)

    it('prices a delivery from the seeded cache row and snapshots the rule on the order', async () => {
      const res = await post(deliveryBody())
      expect(res.status).toBe(200)
      const { orderNumber } = (await res.json()) as { orderNumber: string }
      const rows = await ordersOf(distanceId)
      const order = rows.find(o => o.order_number === orderNumber)!
      expect(Number(order.shipping_fee)).toBe(31.2)
      expect(Number(order.total)).toBe(57.2)
      expect(Number(order.delivery_distance_km)).toBe(25.2)
      expect(Number(order.delivery_base_fee)).toBe(6)
      expect(Number(order.delivery_rate_per_km)).toBe(1)
      // The unit rides along on the address so the rider can complete the drop, and it never
      // touched the fee.
      expect(order.address.unit).toBe('A-3-2')
    })

    // THE BRANCH THIS TASK EXISTS TO ADD. The state guard is
    // `mode === 'delivery' && !distancePriced && deliveryState(...) === null` — every OTHER
    // case above carries `state: 'Selangor'` on its address, so deleting `!distancePriced`
    // leaves the whole suite green. A distance-priced storefront has no reason to collect a
    // state at all (the fee comes from the route, not the region), so THIS is the untested
    // production path: a delivery address with no state key at all must still price and commit.
    it('prices and commits a distance delivery with no state on the address at all', async () => {
      const res = await post(deliveryBody({
        address: { line1: '12 Jalan Test', unit: 'A-3-2', postcode: '50000', city: 'Kuala Lumpur', place_id: NEAR },
      }))
      expect(res.status).toBe(200)
      const { orderNumber } = (await res.json()) as { orderNumber: string }
      const rows = await ordersOf(distanceId)
      const order = rows.find(o => o.order_number === orderNumber)!
      expect(Number(order.shipping_fee)).toBe(31.2)
      expect(Number(order.total)).toBe(57.2)
    })

    it('refuses a delivery whose destination cannot be resolved, and writes nothing', async () => {
      const before = (await ordersOf(distanceId)).length
      const res = await post(deliveryBody({ address: { line1: '12 Jalan Test', postcode: '50000', city: 'KL', state: 'Selangor' } }))
      expect(res.status).toBe(409)
      expect(await errorOf(res)).toBe('delivery_place_required')
      expect((await ordersOf(distanceId)).length).toBe(before)
    })

    it('refuses a destination beyond the shop maximum', async () => {
      const res = await post(deliveryBody({
        address: { line1: 'Far away', postcode: '86000', city: 'Kluang', state: 'Johor', place_id: FAR },
        quotedTotal: 77,
      }))
      expect(res.status).toBe(409)
      expect(await errorOf(res)).toBe('delivery_out_of_range')
    })

    it('rolls the whole transaction back when the derived distance disagrees with the quote', async () => {
      const before = (await ordersOf(distanceId)).length
      const counterBefore = await counterOf(distanceId)
      const res = await post(deliveryBody({ quotedTotal: 40 }))
      expect(res.status).toBe(409)
      expect(await errorOf(res)).toBe('price_changed')
      expect((await ordersOf(distanceId)).length).toBe(before)
      // Not even a counter slot is burnt — the same rollback assertion the voucher cases make.
      expect(await counterOf(distanceId)).toEqual(counterBefore)
    })

    // `body()`'s default `mode: 'pickup'` would let this pass for the wrong reason: a pickup
    // never reaches the distance columns at all, so the assertion would stay green even if a
    // region DELIVERY started writing them. A region delivery is the actual regression this
    // guards against (#101 review, Finding 6) — it prices exactly as it did before #101, and it
    // must go on doing so without picking up a stray distance/base-fee value from the columns
    // the same insert now also has to fill in for a distance shop.
    it('leaves the distance columns null on a region-priced delivery', async () => {
      await svc().from('merchants').update({ shipping: { WM: 8, EM: 18 } }).eq('id', shop)

      const res = await post(body(shop, productId, {
        fulfilDate: tomorrowInShopZone(),
        mode: 'delivery',
        address: { line1: '1 Jalan Besar', postcode: '88000', city: 'Kota Kinabalu', state: 'Sabah' },
        quotedTotal: 44, // 26 + EM 18
      }))
      expect(res.status).toBe(200)
      const rows = await ordersOf(shop)
      const order = rows[rows.length - 1]
      expect(Number(order.shipping_fee)).toBe(18)
      expect(order.delivery_distance_km).toBeNull()
      expect(order.delivery_base_fee).toBeNull()
    })

    // ── `distance_lookup_failed`, and the injected seam that reaches it ────────
    //
    // Three branches raise this code and, before this, none had a test. `placeOrder` is called
    // DIRECTLY here (not through `app.request`) with a fake `DistanceDeps` — the seam it takes
    // `distanceDeps` for — against the real database: only the routing PROVIDER is faked, never
    // Postgres, which is exactly what the seam is for and exactly what this suite's rule
    // (never mock the database) still requires.
    describe('distance_lookup_failed and the injected DistanceDeps seam', () => {
      const placeOrderInput = (extra: Partial<PlaceOrderInput> = {}): PlaceOrderInput => ({
        merchantId: distanceId,
        userId: null,
        userEmail: null,
        customerName: 'Ah Meng',
        customerWa: '60123456789',
        mode: 'express',
        address: { line1: '12 Jalan Test', postcode: '50000', city: 'Kuala Lumpur', state: 'Selangor' },
        cart: { [distanceProductId]: 2 },
        quotedTotal: 57.2,
        voucherCode: null,
        fulfilDate: todayInZone(DEFAULT_TIMEZONE, new Date()),
        destinationPlaceId: 'ChIJord-provider-miss',
        ...extra,
      })

      // Finding 4 (fix wave 2): this refusal fires in `resolveRoutedMetres`, which runs BEFORE
      // `withTransaction` ever opens (see placeOrder's own comment on why routing sits outside
      // the transaction). Nothing could have been written no matter what code runs after it —
      // an implementation with no transaction at all, or one that always rolls back, or one
      // that rolls back correctly, all pass an order-count/counter assertion here identically.
      // So this test asserts only the refusal itself; it proves nothing about rollback, and does
      // not claim to. The two `distance_lookup_failed` throws that DO run inside the
      // transaction (the pre/post shipping-policy mismatch, and the unreachable
      // `shippingPending` guard — both in orders.ts's `placeOrder`) are not exercised by this
      // suite: the mismatch case needs the merchant's `express_enabled` to change between the
      // pre-transaction read (`resolveRoutedMetres`, non-transactional) and the in-transaction
      // read (`assertOrderableMerchant`) while the shop stays REGION-priced at the first read —
      // and `resolveRoutedMetres` returns before ever touching `deps` on that branch, so there
      // is no seam here to hook a side effect off; reaching it would mean timing a real
      // concurrent write against the transaction's own read, which is exactly the kind of
      // flaky, implementation-timing-dependent test this suite avoids elsewhere. Left
      // untested rather than forced.
      it('rejects with distance_lookup_failed when the provider fails, on a cache miss', async () => {
        const { deps } = fakeDistanceDeps({ cached: null, outcome: { status: 'failed' } })

        let err: unknown
        try {
          await placeOrder(placeOrderInput(), new Date(), deps)
        } catch (e) {
          err = e
        }
        expect(err).toBeInstanceOf(OrderError)
        expect((err as OrderError).code).toBe('distance_lookup_failed')
      })

      it('rejects with delivery_out_of_range when the provider finds no route', async () => {
        const { deps } = fakeDistanceDeps({
          cached: null,
          outcome: { status: 'no_route' },
        })

        let err: unknown
        try {
          await placeOrder(placeOrderInput({ destinationPlaceId: 'ChIJord-no-route' }), new Date(), deps)
        } catch (e) {
          err = e
        }
        expect(err).toBeInstanceOf(OrderError)
        expect((err as OrderError).code).toBe('delivery_out_of_range')
      })
    })

    // ── The daily ceiling itself (Finding 3, fix wave 2) ────────────────────────
    //
    // The OLD version of the cache-hit test faked `readCache` to return a distance for EVERY
    // caller — including the one `resolveDistance` makes internally on a miss — so it passed
    // whether or not `resolveRoutedMetres`'s whole peek-and-meter block existed: deleting it
    // left control falling through to `resolveDistance`, which hit the same fake cache and
    // never called `lookup` either. It could not distinguish an injected cache from a real
    // one, and it asserted nothing about the ceiling the block exists to protect in the first
    // place.
    //
    // Rewritten against the REAL cache (`fakeLookupDeps`, faking only `lookup`) to assert the
    // two properties that actually depend on the block existing, both driven against the
    // production `quoteMerchantWindow` singleton directly — keyed (Finding 1) on the
    // merchant's own row id.
    //
    // TWO DEDICATED merchants, not `distanceId` above: `quoteMerchantWindow` is a real
    // module-level singleton shared with the rest of this suite (and, in production, with the
    // quote endpoint too), and each test below needs to know EXACTLY how many slots are left
    // before it spends one or asserts none were spent — something no other test in this file
    // needs. Reusing `distanceId`, or even one merchant for both tests, would make that
    // arithmetic depend on execution order (a prior test's manual `.allow()` calls, or this
    // test's own final assertion call, leaking into the next). A fresh merchant per test is
    // what makes "leave exactly one slot" an actual guarantee instead of a hope.
    //
    // `createSlidingWindow` has no reset hook, so `ceilHitId` and `ceilMissId` (below) are left
    // permanently spent in this process once these two tests have run — harmless today, because
    // each key is touched by exactly one test in this file, but SINGLE-USE: a future test that
    // reaches for either id inherits a poisoned window with no way to clear it. Give any new
    // ceiling test its own fresh merchant, the same way these two got theirs.
    describe('the shop’s daily Google-spend ceiling', () => {
      const CEIL_HIT_SLUG = 'ord-ceiling-hit'
      const CEIL_MISS_SLUG = 'ord-ceiling-miss'
      const CEIL_HIT_ORIGIN = 'ChIJord-ceiling-hit-origin'
      const CEIL_MISS_ORIGIN = 'ChIJord-ceiling-miss-origin'
      const CEIL_HIT_DEST = 'ChIJord-ceiling-hit-dest'
      let ceilHitId = ''
      let ceilHitProductId = ''
      let ceilMissId = ''
      let ceilMissProductId = ''

      beforeAll(async () => {
        const hitOwner = await makeUser('ord-ceiling-hit-owner@test.dev', 'password123')
        const missOwner = await makeUser('ord-ceiling-miss-owner@test.dev', 'password123')
        const hitOwnerId = (await hitOwner.auth.getUser()).data.user!.id
        const missOwnerId = (await missOwner.auth.getUser()).data.user!.id

        ceilHitId = await seedMerchant({
          slug: CEIL_HIT_SLUG, owner_id: hitOwnerId, order_prefix: 'CH',
          express_enabled: true, delivery_base_fee: 6, delivery_rate_per_km: 1,
          delivery_max_km: 30, origin_place_id: CEIL_HIT_ORIGIN,
        })
        ceilHitProductId = await seedProduct({ merchant_id: ceilHitId, price: 13 })
        // Seeded so every request in the hit test is a genuine cache HIT.
        await svc().from('distance_quotes').upsert({
          origin_place_id: CEIL_HIT_ORIGIN, destination_place_id: CEIL_HIT_DEST, metres: 25216,
          created_at: new Date().toISOString(),
        })

        ceilMissId = await seedMerchant({
          slug: CEIL_MISS_SLUG, owner_id: missOwnerId, order_prefix: 'CM',
          express_enabled: true, delivery_base_fee: 6, delivery_rate_per_km: 1,
          delivery_max_km: 30, origin_place_id: CEIL_MISS_ORIGIN,
        })
        ceilMissProductId = await seedProduct({ merchant_id: ceilMissId, price: 13 })
        // Deliberately NOTHING seeded for CEIL_MISS_ORIGIN — every request in the miss test
        // must be a genuine cache miss.
      }, 60_000)

      afterAll(async () => {
        await resetMerchant(CEIL_HIT_SLUG)
        await resetMerchant(CEIL_MISS_SLUG)
        const { error } = await svc()
          .from('distance_quotes')
          .delete()
          .in('origin_place_id', [CEIL_HIT_ORIGIN, CEIL_MISS_ORIGIN])
        if (error) {
          throw new Error(`cleaning up distance_quotes for the ceiling tests: ${error.message}`)
        }
      })

      const ceilInput = (merchantId: string, productId: string, extra: Partial<PlaceOrderInput> = {}): PlaceOrderInput => ({
        merchantId,
        userId: null,
        userEmail: null,
        customerName: 'Ah Meng',
        customerWa: '60123456789',
        mode: 'express',
        address: { line1: '12 Jalan Test', postcode: '50000', city: 'Kuala Lumpur', state: 'Selangor' },
        cart: { [productId]: 2 },
        quotedTotal: 57.2,
        voucherCode: null,
        fulfilDate: todayInZone(DEFAULT_TIMEZONE, new Date()),
        destinationPlaceId: null,
        ...extra,
      })

      it('a cache hit commits the order and never touches the shop’s ceiling', async () => {
        // Spend this merchant's ceiling down to its last slot. `.allow()` returning `false`
        // does not itself record a hit (see rateLimit.ts — the exhausted branch never pushes),
        // so exactly 499 calls leaves exactly one slot open, never zero — and this merchant's
        // key has never been touched before this line, so the count starts at zero for real.
        for (let i = 0; i < 499; i++) quoteMerchantWindow.allow(ceilHitId)

        const { deps, lookupCalls } = fakeLookupDeps()
        // Several hits in a row, all against that ONE remaining slot. Catches a regression
        // that re-adds an unconditional ceiling check — one that fires on a HIT too, not only
        // when `cached === null` — because that would spend the slot on the first call and
        // refuse the second.
        for (let i = 0; i < 5; i++) {
          const { orderNumber } = await placeOrder(
            ceilInput(ceilHitId, ceilHitProductId, { destinationPlaceId: CEIL_HIT_DEST }),
            new Date(),
            deps,
          )
          expect(orderNumber).toBeTruthy()
        }
        expect(lookupCalls()).toBe(0)

        // The behavioural proof the ceiling was never touched: the one slot left standing
        // before the five hits is STILL there afterwards.
        expect(quoteMerchantWindow.allow(ceilHitId)).toBe(true)
      })

      it('a cache miss consumes exactly one slot of the shop’s ceiling', async () => {
        // One slot short of full — the very next miss is the one that must spend it. As above,
        // this merchant's key starts at zero, so 499 calls land exactly one short of the
        // limit (500).
        for (let i = 0; i < 499; i++) quoteMerchantWindow.allow(ceilMissId)

        // 10km -> 6 + 1x10 = 16 shipping, +26 subtotal = 42 total.
        const first = fakeLookupDeps({ status: 'ok', metres: 10_000 })
        const { orderNumber } = await placeOrder(
          ceilInput(ceilMissId, ceilMissProductId, { destinationPlaceId: 'ChIJord-ceiling-miss-1', quotedTotal: 42 }),
          new Date(),
          first.deps,
        )
        expect(orderNumber).toBeTruthy()
        // A GENUINE miss — nothing is seeded at CEIL_MISS_ORIGIN, so the provider really ran.
        // Distinguishes "the metering block let this miss through" from "this was secretly a
        // hit and the ceiling was never actually exercised".
        expect(first.lookupCalls()).toBe(1)

        // The ceiling is now spent. A second, otherwise-identical miss must be refused before
        // ever reaching the provider — the behavioural proof the first miss cost exactly one
        // slot, not zero (a ceiling that were never actually consulted would let this one
        // through too, and `second.lookupCalls()` would read 1, not 0).
        //
        // Sent with the SAME id in a DIFFERENT SPELLING, and that is the entire assertion. Postgres
        // matches `550E8400-…` to the same row as `550e8400-…`, so a ceiling keyed on the body's
        // string would hand this request a fresh, empty bucket and a fresh 500 billable lookups.
        // Keyed on the row's own id, it is the same bucket and stays refused. Same trap the cart keys
        // carry a canonical-form rule for (CONTEXT.md → Order pricing).
        const second = fakeLookupDeps({ status: 'ok', metres: 10_000 })
        let err: unknown
        try {
          await placeOrder(
            ceilInput(ceilMissId.toUpperCase(), ceilMissProductId, { destinationPlaceId: 'ChIJord-ceiling-miss-2', quotedTotal: 42 }),
            new Date(),
            second.deps,
          )
        } catch (e) {
          err = e
        }
        expect(err).toBeInstanceOf(OrderError)
        expect((err as OrderError).code).toBe('distance_lookup_failed')
        expect(second.lookupCalls()).toBe(0)
      })
    })

    // ── The per-IP courtesy bound on the miss path (Finding 2, fix wave 3) ─────
    //
    // `callerIp` appeared nowhere in this file before this block, so the IP check inside
    // `resolveRoutedMetres` shipped with zero coverage. That is not decoration to skip: deleting
    // it, or hoisting it out of the `cached === null` branch so it fires on every delivery order
    // — the blanket limit on order placement the brief explicitly forbids, because it would
    // refuse legitimate customers behind carrier-grade NAT — both leave every other test in this
    // file green.
    //
    // Driven through `placeOrder` directly with an explicit `callerIp`, not through
    // `app.request` with forged `x-forwarded-for`/`cf-connecting-ip` headers: `PlaceOrderInput`
    // already carries the seam for exactly this (see its doc comment), and using it is the
    // honest way to pin the property, the same choice the ceiling tests above already made for
    // `quoteMerchantWindow`.
    //
    // TWO DEDICATED merchants and TWO DEDICATED IP strings — never `distanceId`, `ceilHitId` or
    // `ceilMissId`, and never an IP any other test in this file might touch — so exhausting
    // `quoteIpWindow` here cannot interact with the ceiling tests' fixtures or any other test's
    // bucket. `quoteIpWindow` has no reset hook either, so `IP_HIT_CALLER`/`IP_MISS_CALLER` are
    // left permanently exhausted after this block runs, same single-use caveat as the ceiling
    // merchants above.
    describe('the per-IP courtesy bound on the miss path', () => {
      const IP_HIT_SLUG = 'ord-ip-hit'
      const IP_MISS_SLUG = 'ord-ip-miss'
      const IP_HIT_ORIGIN = 'ChIJord-ip-hit-origin'
      const IP_MISS_ORIGIN = 'ChIJord-ip-miss-origin'
      const IP_HIT_DEST = 'ChIJord-ip-hit-dest'
      const IP_HIT_CALLER = '203.0.113.11'
      const IP_MISS_CALLER = '203.0.113.22'
      let ipHitId = ''
      let ipHitProductId = ''
      let ipMissId = ''
      let ipMissProductId = ''

      beforeAll(async () => {
        const hitOwner = await makeUser('ord-ip-hit-owner@test.dev', 'password123')
        const missOwner = await makeUser('ord-ip-miss-owner@test.dev', 'password123')
        const hitOwnerId = (await hitOwner.auth.getUser()).data.user!.id
        const missOwnerId = (await missOwner.auth.getUser()).data.user!.id

        ipHitId = await seedMerchant({
          slug: IP_HIT_SLUG, owner_id: hitOwnerId, order_prefix: 'IH',
          express_enabled: true, delivery_base_fee: 6, delivery_rate_per_km: 1,
          delivery_max_km: 30, origin_place_id: IP_HIT_ORIGIN,
        })
        ipHitProductId = await seedProduct({ merchant_id: ipHitId, price: 13 })
        // Seeded so every request in the hit test is a genuine cache HIT.
        await svc().from('distance_quotes').upsert({
          origin_place_id: IP_HIT_ORIGIN, destination_place_id: IP_HIT_DEST, metres: 25216,
          created_at: new Date().toISOString(),
        })

        ipMissId = await seedMerchant({
          slug: IP_MISS_SLUG, owner_id: missOwnerId, order_prefix: 'IM',
          express_enabled: true, delivery_base_fee: 6, delivery_rate_per_km: 1,
          delivery_max_km: 30, origin_place_id: IP_MISS_ORIGIN,
        })
        ipMissProductId = await seedProduct({ merchant_id: ipMissId, price: 13 })
        // Deliberately NOTHING seeded for IP_MISS_ORIGIN — every request in the miss test
        // must be a genuine cache miss.
      }, 60_000)

      afterAll(async () => {
        await resetMerchant(IP_HIT_SLUG)
        await resetMerchant(IP_MISS_SLUG)
        const { error } = await svc()
          .from('distance_quotes')
          .delete()
          .in('origin_place_id', [IP_HIT_ORIGIN, IP_MISS_ORIGIN])
        if (error) {
          throw new Error(`cleaning up distance_quotes for the IP-bound tests: ${error.message}`)
        }
      })

      const ipInput = (
        merchantId: string,
        productId: string,
        callerIp: string,
        extra: Partial<PlaceOrderInput> = {},
      ): PlaceOrderInput => ({
        merchantId,
        userId: null,
        userEmail: null,
        customerName: 'Ah Meng',
        customerWa: '60123456789',
        mode: 'express',
        address: { line1: '12 Jalan Test', postcode: '50000', city: 'Kuala Lumpur', state: 'Selangor' },
        cart: { [productId]: 2 },
        quotedTotal: 57.2,
        voucherCode: null,
        fulfilDate: todayInZone(DEFAULT_TIMEZONE, new Date()),
        destinationPlaceId: null,
        callerIp,
        ...extra,
      })

      /** Spends every remaining slot in `quoteIpWindow` for `key`, however many that is. */
      function exhaustIpWindow(key: string): void {
        let guard = 0
        while (quoteIpWindow.allow(key)) {
          guard++
          if (guard > 10_000) throw new Error(`quoteIpWindow for ${key} never exhausted`)
        }
      }

      it('a cache hit still commits when that IP’s bucket is exhausted', async () => {
        exhaustIpWindow(IP_HIT_CALLER)
        expect(quoteIpWindow.allow(IP_HIT_CALLER)).toBe(false)

        const { deps, lookupCalls } = fakeLookupDeps()
        const { orderNumber } = await placeOrder(
          ipInput(ipHitId, ipHitProductId, IP_HIT_CALLER, { destinationPlaceId: IP_HIT_DEST }),
          new Date(),
          deps,
        )
        expect(orderNumber).toBeTruthy()
        // The provider was never called — a genuine, unmetered hit. Fails the moment the IP
        // check is hoisted out of the `cached === null` block: an exhausted bucket would then
        // refuse this HIT too, and `placeOrder` would throw instead of returning.
        expect(lookupCalls()).toBe(0)
      })

      it('a cache miss is refused when that IP’s bucket is exhausted', async () => {
        exhaustIpWindow(IP_MISS_CALLER)
        expect(quoteIpWindow.allow(IP_MISS_CALLER)).toBe(false)

        const { deps, lookupCalls } = fakeLookupDeps({ status: 'ok', metres: 10_000 })
        let err: unknown
        try {
          await placeOrder(
            ipInput(ipMissId, ipMissProductId, IP_MISS_CALLER, { destinationPlaceId: 'ChIJord-ip-miss-1' }),
            new Date(),
            deps,
          )
        } catch (e) {
          err = e
        }
        // Fails the moment the IP check is deleted outright: with no check at all, this miss
        // would resolve through the real provider and commit instead of refusing.
        expect(err).toBeInstanceOf(OrderError)
        expect((err as OrderError).code).toBe('distance_lookup_failed')
        expect(lookupCalls()).toBe(0)
      })
    })

    afterAll(async () => {
      // Fixture leak (#101 review): rows this suite seeded into `distance_quotes`, keyed by its
      // own ChIJord-* place ids. `resetMerchant` only ever clears tables scoped by
      // `merchant_id`, and `distance_quotes` is keyed by place id pair alone (see the migration
      // comment), so nothing else was ever going to remove these.
      //
      // The error is checked, like every other seed/cleanup helper in this file (Finding 6, fix
      // wave 2) — a silently failing delete here restores exactly the leak this cleanup exists
      // to close, with the suite still reporting green.
      const { error } = await svc().from('distance_quotes').delete().eq('origin_place_id', ORIGIN)
      if (error) throw new Error(`cleaning up distance_quotes for ${ORIGIN}: ${error.message}`)
    })
  })
})

describe('GET /api/time', () => {
  it('returns a parseable instant', async () => {
    const res = await app.request('/api/time')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { now: string }
    expect(Number.isFinite(Date.parse(body.now))).toBe(true)
  })
})
