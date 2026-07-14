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
import { app } from '../../src/app.js'
import { makeUser, resetMerchant, seedMerchant, seedProduct, serviceClient } from '../rls/helpers.js'
import { orderDay } from '../../src/orderNumber.js'

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

describe('POST /api/orders', () => {
  let shop: string
  let pendingShop: string
  let suspendedShop: string
  let productId: string
  let customerToken: string
  let customerId: string
  let strangerId: string

  beforeAll(async () => {
    const owner = await makeUser('ord-owner@test.dev', 'password123')
    const otherOwner = await makeUser('ord-other-owner@test.dev', 'password123')
    const customer = await makeUser('ord-customer@test.dev', 'password123')
    const stranger = await makeUser('ord-stranger@test.dev', 'password123')

    const ownerId = (await owner.auth.getUser()).data.user!.id
    const otherOwnerId = (await otherOwner.auth.getUser()).data.user!.id
    customerId = (await customer.auth.getUser()).data.user!.id
    strangerId = (await stranger.auth.getUser()).data.user!.id
    customerToken = (await customer.auth.getSession()).data.session!.access_token

    // The closed shops get a different owner: current_merchant_id() resolves one shop per
    // owner, so piling three onto one owner is a state the app cannot represent.
    shop = await seedMerchant({ slug: 'ord-shop', order_prefix: 'OR', owner_id: ownerId })
    pendingShop = await seedMerchant({ slug: 'ord-pending', order_prefix: 'OP', owner_id: otherOwnerId, status: 'pending' })
    suspendedShop = await seedMerchant({ slug: 'ord-suspended', order_prefix: 'OS', owner_id: otherOwnerId, status: 'suspended' })
  }, 30_000)

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
  })

  afterAll(async () => {
    for (const slug of SLUGS) await resetMerchant(slug)
  })

  // ── The happy path, and the format that must not move ───────────────────────

  it('places an order and returns its number', async () => {
    const res = await post(body(shop, productId))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ orderNumber: `OR-${DAY}-0050` })
  })

  it('writes the order row, with the cart and the total', async () => {
    await post(body(shop, productId))
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
    const first = await post(body(shop, productId))
    const second = await post(body(shop, productId))

    expect(await first.json()).toEqual({ orderNumber: `OR-${DAY}-0050` })
    expect(await second.json()).toEqual({ orderNumber: `OR-${DAY}-0051` })
  })

  // ── The intake gate, now a TypeScript invariant (db.ts bypasses RLS) ───────

  it('refuses an order against a pending shop, and writes nothing', async () => {
    const res = await post(body(pendingShop, productId))

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'merchant_inactive' })
    expect(await ordersOf(pendingShop)).toEqual([])
    expect(await counterOf(pendingShop)).toBeNull()
  })

  it('refuses an order against a suspended shop, and writes nothing', async () => {
    const res = await post(body(suspendedShop, productId))

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'merchant_inactive' })
    expect(await ordersOf(suspendedShop)).toEqual([])
  })

  it('refuses an order against a merchant that does not exist', async () => {
    const res = await post(body('00000000-0000-0000-0000-000000000000', productId))

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'merchant_not_found' })
  })

  // The insert policy used to enforce this. It no longer runs on the backend's connection,
  // so the endpoint has to — a client must not be able to file an already-completed order.
  it('never persists a status the client asked for', async () => {
    await post(body(shop, productId, { status: 'done' }))
    const [order] = await ordersOf(shop)

    expect(order.status).toBe('new')
  })

  // A number field that is not a number is the CLIENT's bug. Coercing it (`Number('abc')` →
  // NaN) would push it all the way to Postgres and return a 500 — a bad request reported as a
  // server fault, and a lie in the logs when someone comes to debug it.
  it('rejects a malformed body rather than coercing it into a 500', async () => {
    const res = await post(body(shop, productId, { quotedTotal: 'abc' }))

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
        const res = await post(body(shop, productId, { cart: { [productId]: qty } }))

        expect(res.status).toBe(400)
        expect(await errorOf(res)).toBe('invalid_body')
        expect(await ordersOf(shop)).toEqual([])
      })
    }

    it('rejects an empty cart', async () => {
      const res = await post(body(shop, productId, { cart: {} }))

      expect(res.status).toBe(400)
      expect(await errorOf(res)).toBe('invalid_body')
      expect(await ordersOf(shop)).toEqual([])
    })

    // An array has no ids at all — `Object.values([])` is empty, so a laxer check would call
    // it valid and hand cartProducts a cart with nothing in it.
    it('rejects a cart sent as an array', async () => {
      const res = await post(body(shop, productId, { cart: [] }))

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
    await post(body(shop, productId), customerToken)
    const [order] = await ordersOf(shop)

    expect(order.user_id).toBe(customerId)
  })

  it('leaves a guest’s order unattributed', async () => {
    await post(body(shop, productId))
    const [order] = await ordersOf(shop)

    expect(order.user_id).toBeNull()
  })

  // The spoofing hole the orders_set_user_id trigger was written to close. The trigger now
  // coalesces rather than overwrites — safe ONLY because anon/authenticated lost INSERT, so
  // anything reaching it with a settable user_id is this backend. The endpoint must therefore
  // never take user_id from the body, and these two tests are what hold that line.
  it('ignores a user_id in a guest’s body — a guest cannot attribute an order to anyone', async () => {
    await post(body(shop, productId, { user_id: strangerId, userId: strangerId }))
    const [order] = await ordersOf(shop)

    expect(order.user_id).toBeNull()
  })

  it('ignores a stranger’s user_id in a signed-in customer’s body', async () => {
    await post(body(shop, productId, { user_id: strangerId, userId: strangerId }), customerToken)
    const [order] = await ordersOf(shop)

    expect(order.user_id).toBe(customerId)
  })

  // ── Vouchers: the claim commits with the order, or not at all ───────────────

  it('claims the voucher and records the order’s discount', async () => {
    await seedVoucher(shop, 'SAVE5', null)

    const res = await post(body(shop, productId, { quotedTotal: 21, voucherCode: 'SAVE5', voucherEntry: 'ah@meng.my' }))

    expect(res.status).toBe(200)
    const [order] = await ordersOf(shop)
    expect(order).toMatchObject({ discount: 5, voucher_code: 'SAVE5', total: 21 })
    expect((await voucherOf(shop, 'SAVE5'))!.used_by).toEqual(['ah@meng.my'])
  })

  it('rejects a voucher code that does not exist', async () => {
    const res = await post(body(shop, productId, { quotedTotal: 21, voucherCode: 'NOPE', voucherEntry: 'ah@meng.my' }))

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'voucher_not_found' })
  })

  it('rejects a voucher this customer already used', async () => {
    await seedVoucher(shop, 'SAVE5', null)
    await post(body(shop, productId, { quotedTotal: 21, voucherCode: 'SAVE5', voucherEntry: 'ah@meng.my' }))

    const res = await post(body(shop, productId, { quotedTotal: 21, voucherCode: 'SAVE5', voucherEntry: 'ah@meng.my' }))

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'voucher_already_used' })
  })

  it('rejects a voucher that has hit its cap', async () => {
    await seedVoucher(shop, 'CAP1', 1)
    await post(body(shop, productId, { quotedTotal: 21, voucherCode: 'CAP1', voucherEntry: 'first@x.my' }))

    const res = await post(body(shop, productId, { quotedTotal: 21, voucherCode: 'CAP1', voucherEntry: 'second@x.my' }))

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'voucher_fully_used' })
  })

  // THE BUG THIS TICKET EXISTS TO KILL. Before, the order was already committed by the time
  // the redemption failed — so the customer kept a discount on a voucher never marked used.
  it('rolls the whole order back when the voucher claim fails — no row, no burnt counter', async () => {
    const res = await post(body(shop, productId, { quotedTotal: 21, voucherCode: 'NOPE', voucherEntry: 'ah@meng.my' }))

    expect(res.status).toBe(409)
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

    const res = await post(body(shop, productId, { quotedTotal: 21, voucherCode: 'SAVE5', voucherEntry: 'ah@meng.my' }))

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
    const failed = await post(body(shop, productId, { quotedTotal: 21, voucherCode: 'NOPE', voucherEntry: 'ah@meng.my' }))
    expect(failed.status).toBe(409)

    const retry = await post(body(shop, productId))

    expect(retry.status).toBe(200)
    // The failed attempt burned nothing: this is still the day's FIRST order.
    expect(await retry.json()).toEqual({ orderNumber: `OR-${DAY}-0050` })
  })

  // ── Concurrency. Real row locks, real Postgres — the point of the driver ────

  it('gives two concurrent orders distinct order numbers', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => post(body(shop, productId))))
    const numbers = await Promise.all(results.map(r => r.json() as Promise<{ orderNumber: string }>))

    const distinct = new Set(numbers.map(n => n.orderNumber))
    expect(distinct.size).toBe(8)
    expect(results.every(r => r.status === 200)).toBe(true)
  })

  it('lets exactly one of two concurrent orders redeem a single-use voucher', async () => {
    await seedVoucher(shop, 'ONCE', 1)
    const one = () => post(body(shop, productId, { quotedTotal: 21, voucherCode: 'ONCE', voucherEntry: 'ah@meng.my' }))

    const [a, b] = await Promise.all([one(), one()])
    const statuses = [a.status, b.status].sort()

    expect(statuses).toEqual([200, 409])
    const loser = a.status === 409 ? a : b
    expect(await loser.json()).toEqual({ error: 'voucher_already_used' })
    expect((await voucherOf(shop, 'ONCE'))!.used_by).toEqual(['ah@meng.my'])
    expect(await ordersOf(shop)).toHaveLength(1)
  })

  // A fifty-use voucher redeemed five hundred times is the merchant's solvency. The cap has
  // to hold when the redemptions arrive at once, which is exactly when a read-then-write
  // without a row lock does not.
  it('holds a voucher’s cap under concurrent load', async () => {
    await seedVoucher(shop, 'CAP2', 2)
    const attempts = Array.from({ length: 6 }, (_, i) =>
      post(body(shop, productId, { quotedTotal: 21, voucherCode: 'CAP2', voucherEntry: `c${i}@x.my` })),
    )

    const results = await Promise.all(attempts)
    const ok = results.filter(r => r.status === 200)
    const rejected = results.filter(r => r.status === 409)

    expect(ok).toHaveLength(2)
    expect(rejected).toHaveLength(4)
    expect((await voucherOf(shop, 'CAP2'))!.used_by).toHaveLength(2)
    // Only the two that redeemed it left an order behind — the other four rolled back whole.
    expect(await ordersOf(shop)).toHaveLength(2)
  })

  describe('the backend is the price authority', () => {
    it('refuses a body that names its own total, and writes nothing', async () => {
      // THE HOLE THIS TASK CLOSES. Before it, this committed an order at zero.
      const res = await post(body(shop, productId, { quotedTotal: 0 }))
      expect(res.status).toBe(409)
      expect(await errorOf(res)).toBe('price_changed')
      expect(await ordersOf(shop)).toHaveLength(0)
    })

    // The body states every price it can, and none of them survive. Same shape as `never
    // persists a status the client asked for`: the hostile value is SENT, and the committed
    // row is what proves it was ignored rather than merely absent.
    it('commits the server-derived total and items, not anything the body said', async () => {
      const res = await post(body(shop, productId, {
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
      // whatever the browser felt like calling them.
      expect(order.items).toEqual([
        { id: productId, name: 'Matcha Cookie', qty: 2, price: 13 },
      ])
    })

    it('refuses with price_changed when the price moves between quote and submit', async () => {
      await svc().from('products').update({ price: 15 }).eq('id', productId)

      const res = await post(body(shop, productId))  // still quoting the old 26
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

      const res = await post(body(shop, strangersProduct))
      expect(res.status).toBe(409)
      expect(await errorOf(res)).toBe('product_unavailable')
      expect(await ordersOf(shop)).toHaveLength(0)
    })

    it('refuses a product that is not active', async () => {
      const hidden = await seedProduct({ merchant_id: shop, price: 13, active: false })

      const res = await post(body(shop, hidden))
      expect(res.status).toBe(409)
      expect(await errorOf(res)).toBe('product_unavailable')
      expect(await ordersOf(shop)).toHaveLength(0)
    })

    it('refuses a cart id that is not a product id, as a refusal and not a 500', async () => {
      const res = await post(body(shop, productId, { cart: { 'not-a-uuid': 1 } }))
      expect(res.status).toBe(409)
      expect(await errorOf(res)).toBe('product_unavailable')
    })

    it('derives the shipping fee from the shop rates and the delivery region', async () => {
      await svc().from('merchants').update({ shipping: { WM: 8, EM: 18 } }).eq('id', shop)

      const res = await post(body(shop, productId, {
        mode: 'delivery',
        address: { line1: '1 Jalan Besar', postcode: '88000', city: 'Kota Kinabalu', state: 'Sabah' },
        quotedTotal: 44,   // 26 + EM 18
      }))
      expect(res.status).toBe(200)

      const [order] = await ordersOf(shop)
      expect(Number(order.shipping_fee)).toBe(18)
      expect(Number(order.total)).toBe(44)
    })

    it('derives the voucher discount, and records it against the order', async () => {
      await svc().from('vouchers').insert({
        merchant_id: shop, code: 'SAVE10', kind: 'percent', amount: 10, used_by: [],
      })

      const res = await post(body(shop, productId, {
        voucherCode: 'SAVE10',
        voucherEntry: 'ah@meng.com',
        quotedTotal: 23.4,   // 26 − 10%
      }))
      expect(res.status).toBe(200)

      const [order] = await ordersOf(shop)
      expect(Number(order.discount)).toBe(2.6)
      expect(Number(order.total)).toBe(23.4)
      expect(order.voucher_code).toBe('SAVE10')
    })
  })
})
