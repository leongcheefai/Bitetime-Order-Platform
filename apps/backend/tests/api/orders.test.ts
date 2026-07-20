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
import { MAX_CART_QTY, MAX_CART_LINES, todayInZone, DEFAULT_TIMEZONE } from '@bitetime/shared'

const SLUGS = ['ord-shop', 'ord-pending', 'ord-suspended']
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
    it('refuses an order with no fulfilment date', async () => {
      const res = await post(body(shop, productId)) // carries no fulfilDate

      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'fulfil_date_required' })
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
})

describe('GET /api/time', () => {
  it('returns a parseable instant', async () => {
    const res = await app.request('/api/time')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { now: string }
    expect(Number.isFinite(Date.parse(body.now))).toBe(true)
  })
})
