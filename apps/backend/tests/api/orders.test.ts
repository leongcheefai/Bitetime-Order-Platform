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
import { makeUser, resetMerchant, seedMerchant, serviceClient } from '../rls/helpers.js'
import { orderDay } from '../../src/orderNumber.js'

const SLUGS = ['ord-shop', 'ord-pending', 'ord-suspended']
const DAY = orderDay(new Date())

/** A cart that prices to 26, shaped like the one the storefront sends. */
function body(merchantId: string, extra: Record<string, unknown> = {}) {
  return {
    merchantId,
    customerName: 'Ah Meng',
    customerWa: '60123456789',
    mode: 'pickup',
    items: [{ id: 'p1', name: 'Matcha Cookie', qty: 2, price: 13 }],
    total: 26,
    shippingFee: 0,
    currency: 'MYR',
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
  // execution order.
  beforeEach(async () => {
    await svc().from('orders').delete().eq('merchant_id', shop)
    await svc().from('order_counters').delete().eq('merchant_id', shop)
    await svc().from('vouchers').delete().eq('merchant_id', shop)
  })

  afterAll(async () => {
    for (const slug of SLUGS) await resetMerchant(slug)
  })

  // ── The happy path, and the format that must not move ───────────────────────

  it('places an order and returns its number', async () => {
    const res = await post(body(shop))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ orderNumber: `OR-${DAY}-0050` })
  })

  it('writes the order row, with the cart and the total', async () => {
    await post(body(shop))
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
    const first = await post(body(shop))
    const second = await post(body(shop))

    expect(await first.json()).toEqual({ orderNumber: `OR-${DAY}-0050` })
    expect(await second.json()).toEqual({ orderNumber: `OR-${DAY}-0051` })
  })

  // ── The intake gate, now a TypeScript invariant (db.ts bypasses RLS) ───────

  it('refuses an order against a pending shop, and writes nothing', async () => {
    const res = await post(body(pendingShop))

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'merchant_inactive' })
    expect(await ordersOf(pendingShop)).toEqual([])
    expect(await counterOf(pendingShop)).toBeNull()
  })

  it('refuses an order against a suspended shop, and writes nothing', async () => {
    const res = await post(body(suspendedShop))

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'merchant_inactive' })
    expect(await ordersOf(suspendedShop)).toEqual([])
  })

  it('refuses an order against a merchant that does not exist', async () => {
    const res = await post(body('00000000-0000-0000-0000-000000000000'))

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'merchant_not_found' })
  })

  // The insert policy used to enforce this. It no longer runs on the backend's connection,
  // so the endpoint has to — a client must not be able to file an already-completed order.
  it('never persists a status the client asked for', async () => {
    await post(body(shop, { status: 'done' }))
    const [order] = await ordersOf(shop)

    expect(order.status).toBe('new')
  })

  // A number field that is not a number is the CLIENT's bug. Coercing it (`Number('abc')` →
  // NaN) would push it all the way to Postgres and return a 500 — a bad request reported as a
  // server fault, and a lie in the logs when someone comes to debug it.
  it('rejects a malformed body rather than coercing it into a 500', async () => {
    const res = await post(body(shop, { total: 'abc' }))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_body' })
    expect(await ordersOf(shop)).toEqual([])
  })

  // ── Attribution: the JWT decides, the body never does ───────────────────────

  it('attributes a signed-in customer’s order to them', async () => {
    await post(body(shop), customerToken)
    const [order] = await ordersOf(shop)

    expect(order.user_id).toBe(customerId)
  })

  it('leaves a guest’s order unattributed', async () => {
    await post(body(shop))
    const [order] = await ordersOf(shop)

    expect(order.user_id).toBeNull()
  })

  // The spoofing hole the orders_set_user_id trigger was written to close. The trigger now
  // coalesces rather than overwrites — safe ONLY because anon/authenticated lost INSERT, so
  // anything reaching it with a settable user_id is this backend. The endpoint must therefore
  // never take user_id from the body, and these two tests are what hold that line.
  it('ignores a user_id in a guest’s body — a guest cannot attribute an order to anyone', async () => {
    await post(body(shop, { user_id: strangerId, userId: strangerId }))
    const [order] = await ordersOf(shop)

    expect(order.user_id).toBeNull()
  })

  it('ignores a stranger’s user_id in a signed-in customer’s body', async () => {
    await post(body(shop, { user_id: strangerId, userId: strangerId }), customerToken)
    const [order] = await ordersOf(shop)

    expect(order.user_id).toBe(customerId)
  })

  // ── Vouchers: the claim commits with the order, or not at all ───────────────

  it('claims the voucher and records the order’s discount', async () => {
    await seedVoucher(shop, 'SAVE5', null)

    const res = await post(body(shop, { discount: 5, total: 21, voucherCode: 'SAVE5', voucherEntry: 'ah@meng.my' }))

    expect(res.status).toBe(200)
    const [order] = await ordersOf(shop)
    expect(order).toMatchObject({ discount: 5, voucher_code: 'SAVE5', total: 21 })
    expect((await voucherOf(shop, 'SAVE5'))!.used_by).toEqual(['ah@meng.my'])
  })

  it('rejects a voucher code that does not exist', async () => {
    const res = await post(body(shop, { discount: 5, total: 21, voucherCode: 'NOPE', voucherEntry: 'ah@meng.my' }))

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'voucher_not_found' })
  })

  it('rejects a voucher this customer already used', async () => {
    await seedVoucher(shop, 'SAVE5', null)
    await post(body(shop, { discount: 5, total: 21, voucherCode: 'SAVE5', voucherEntry: 'ah@meng.my' }))

    const res = await post(body(shop, { discount: 5, total: 21, voucherCode: 'SAVE5', voucherEntry: 'ah@meng.my' }))

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'voucher_already_used' })
  })

  it('rejects a voucher that has hit its cap', async () => {
    await seedVoucher(shop, 'CAP1', 1)
    await post(body(shop, { discount: 5, total: 21, voucherCode: 'CAP1', voucherEntry: 'first@x.my' }))

    const res = await post(body(shop, { discount: 5, total: 21, voucherCode: 'CAP1', voucherEntry: 'second@x.my' }))

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'voucher_fully_used' })
  })

  // THE BUG THIS TICKET EXISTS TO KILL. Before, the order was already committed by the time
  // the redemption failed — so the customer kept a discount on a voucher never marked used.
  it('rolls the whole order back when the voucher claim fails — no row, no burnt counter', async () => {
    const res = await post(body(shop, { discount: 5, total: 21, voucherCode: 'NOPE', voucherEntry: 'ah@meng.my' }))

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

    const res = await post(body(shop, { discount: 5, total: 21, voucherCode: 'SAVE5', voucherEntry: 'ah@meng.my' }))

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
    const failed = await post(body(shop, { discount: 5, total: 21, voucherCode: 'NOPE', voucherEntry: 'ah@meng.my' }))
    expect(failed.status).toBe(409)

    const retry = await post(body(shop))

    expect(retry.status).toBe(200)
    // The failed attempt burned nothing: this is still the day's FIRST order.
    expect(await retry.json()).toEqual({ orderNumber: `OR-${DAY}-0050` })
  })

  // ── Concurrency. Real row locks, real Postgres — the point of the driver ────

  it('gives two concurrent orders distinct order numbers', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => post(body(shop))))
    const numbers = await Promise.all(results.map(r => r.json() as Promise<{ orderNumber: string }>))

    const distinct = new Set(numbers.map(n => n.orderNumber))
    expect(distinct.size).toBe(8)
    expect(results.every(r => r.status === 200)).toBe(true)
  })

  it('lets exactly one of two concurrent orders redeem a single-use voucher', async () => {
    await seedVoucher(shop, 'ONCE', 1)
    const one = () => post(body(shop, { discount: 5, total: 21, voucherCode: 'ONCE', voucherEntry: 'ah@meng.my' }))

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
      post(body(shop, { discount: 5, total: 21, voucherCode: 'CAP2', voucherEntry: `c${i}@x.my` })),
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
})
