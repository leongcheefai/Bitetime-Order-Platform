// tests/api/order-cancel-voucher.test.ts
// Cancelling an order RELEASES the voucher redemption it spent, and un-cancelling takes it back.
//
// The rule is state-driven, not transition-driven: a redemption is void if and only if its order
// is `cancelled`. That is what makes the write idempotent. The void now runs inside the order
// patch's own transaction (ADR 0025), so a void that fails rolls the patch back with it.
//
// Every assertion here is against the CAP, not against the column. `voided_at` is only real if
// `claimVoucher` stops counting the row: a suite that read the column would pass just as happily
// against a release the checkout path never sees. So each case proves the freed slot by placing a
// second order through the real intake and watching it be taken or refused.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { sql } from '../../src/db.js'
import { app } from '../../src/app.js'
import { makeUser, resetMerchant, seedMerchant, seedProduct, serviceClient } from '../rls/helpers.js'
import { todayInZone, DEFAULT_TIMEZONE } from '@bitetime/shared'

const SLUG = 'cxl-shop'

const svc = () => serviceClient()

/** A date the default fulfilment config is certainly taking: today + 1, on the shop's clock. */
function tomorrowInShopZone(): string {
  const today = todayInZone(DEFAULT_TIMEZONE, new Date())
  return new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
}

/** 2 × RM13 = 26, less the RM5 voucher = 21. */
function orderBody(merchantId: string, productId: string, voucherCode: string) {
  return {
    merchantId,
    customerName: 'Ah Meng',
    customerWa: '60123456789',
    mode: 'pickup',
    cart: [{ productId, qty: 2, selections: [] }],
    quotedTotal: 21,
    fulfilDate: tomorrowInShopZone(),
    voucherCode,
  }
}

function placeOrder(merchantId: string, productId: string, code: string, token: string) {
  return app.request('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(orderBody(merchantId, productId, code)),
  })
}

function patchOrder(merchantId: string, orderId: string, patch: Record<string, unknown>, token: string) {
  return app.request(`/api/merchants/${merchantId}/orders/${orderId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(patch),
  })
}

async function seedVoucher(merchantId: string, code: string, extra: Record<string, unknown> = {}) {
  await svc().from('vouchers').delete().eq('merchant_id', merchantId).eq('code', code)
  const { error } = await svc()
    .from('vouchers')
    .insert({ merchant_id: merchantId, code, kind: 'fixed', amount: 5, max_uses: null, used_by: [], ...extra })
  if (error) throw new Error(`seeding voucher ${code}: ${error.message}`)
}

/**
 * The redemption rows for one order. Read over `db.ts`, not the REST client:
 * `voucher_redemptions` holds no grants for any PostgREST role, so `svc().from(...)` comes back
 * empty and every assertion built on it would pass while proving nothing.
 */
async function redemptionsOfOrder(orderId: string) {
  return await sql<{ voided_at: string | null }[]>`
    select voided_at from voucher_redemptions where order_id = ${orderId}
  `
}

describe('cancelling an order releases its voucher redemption', () => {
  let shop: string
  let productId: string
  let ownerToken: string
  let customerToken: string
  let strangerToken: string

  beforeAll(async () => {
    await resetMerchant(SLUG)
    const owner = await makeUser('cxl-owner@test.dev', 'password123')
    const customer = await makeUser('cxl-customer@test.dev', 'password123')
    const stranger = await makeUser('cxl-stranger@test.dev', 'password123')

    ownerToken = (await owner.auth.getSession()).data.session!.access_token
    customerToken = (await customer.auth.getSession()).data.session!.access_token
    strangerToken = (await stranger.auth.getSession()).data.session!.access_token

    shop = await seedMerchant({
      slug: SLUG,
      order_prefix: 'CX',
      owner_id: (await owner.auth.getUser()).data.user!.id,
    })
  }, 60_000)

  beforeEach(async () => {
    await svc().from('orders').delete().eq('merchant_id', shop)
    await svc().from('order_counters').delete().eq('merchant_id', shop)
    await svc().from('vouchers').delete().eq('merchant_id', shop)
    await svc().from('products').delete().eq('merchant_id', shop)
    productId = await seedProduct({ merchant_id: shop, price: 13 })
  })

  afterAll(async () => {
    await resetMerchant(SLUG)
  })

  it('frees a slot against the SHOP’s cap', async () => {
    await seedVoucher(shop, 'CAP1', { max_uses: 1 })

    const first = await placeOrder(shop, productId, 'CAP1', customerToken)
    expect(first.status).toBe(200)
    const { id: orderId } = (await first.json()) as { id: string }

    // The cap is spent: a second customer cannot have it.
    const blocked = await placeOrder(shop, productId, 'CAP1', strangerToken)
    expect(blocked.status).toBe(409)
    expect(await blocked.json()).toEqual({ error: 'voucher_fully_used' })

    expect((await patchOrder(shop, orderId, { status: 'cancelled' }, ownerToken)).status).toBe(200)
    expect((await redemptionsOfOrder(orderId))[0].voided_at).not.toBeNull()

    // …and now it can. This is the assertion that matters: the freed slot is only real if
    // `claimVoucher`'s own count under the row lock stopped seeing the voided row.
    const freed = await placeOrder(shop, productId, 'CAP1', strangerToken)
    expect(freed.status).toBe(200)
  })

  it('frees a slot against the CUSTOMER’s own allowance', async () => {
    // per_customer_limit defaults to 1 — the rule every voucher predating #241 was created under.
    await seedVoucher(shop, 'MINE1')

    const first = await placeOrder(shop, productId, 'MINE1', customerToken)
    expect(first.status).toBe(200)
    const { id: orderId } = (await first.json()) as { id: string }

    const blocked = await placeOrder(shop, productId, 'MINE1', customerToken)
    expect(blocked.status).toBe(409)
    expect(await blocked.json()).toEqual({ error: 'voucher_customer_limit_reached' })

    await patchOrder(shop, orderId, { status: 'cancelled' }, ownerToken)

    const freed = await placeOrder(shop, productId, 'MINE1', customerToken)
    expect(freed.status).toBe(200)
  })

  it('takes the slot back when the merchant un-cancels', async () => {
    await seedVoucher(shop, 'BACK1', { max_uses: 1 })

    const first = await placeOrder(shop, productId, 'BACK1', customerToken)
    const { id: orderId } = (await first.json()) as { id: string }

    await patchOrder(shop, orderId, { status: 'cancelled' }, ownerToken)
    // Un-cancelled, unconditionally: a mis-click must be correctable, so the restore never
    // re-checks the cap.
    expect((await patchOrder(shop, orderId, { status: 'preparing' }, ownerToken)).status).toBe(200)
    expect((await redemptionsOfOrder(orderId))[0].voided_at).toBeNull()

    const blocked = await placeOrder(shop, productId, 'BACK1', strangerToken)
    expect(blocked.status).toBe(409)
    expect(await blocked.json()).toEqual({ error: 'voucher_fully_used' })
  })

  it('keeps the first void’s timestamp when the same order is cancelled twice', async () => {
    await seedVoucher(shop, 'TWICE1', { max_uses: 1 })

    const first = await placeOrder(shop, productId, 'TWICE1', customerToken)
    const { id: orderId } = (await first.json()) as { id: string }

    await patchOrder(shop, orderId, { status: 'cancelled' }, ownerToken)
    const once = (await redemptionsOfOrder(orderId))[0].voided_at
    await patchOrder(shop, orderId, { status: 'cancelled' }, ownerToken)

    // Idempotent, and the record of WHEN the slot was released does not move under a repeat.
    expect((await redemptionsOfOrder(orderId))[0].voided_at).toEqual(once)
  })

  it('cannot free a slot by cancelling a COMPLETED order', async () => {
    // ADR 0024, asserted where it matters: against the cap, not the column. A shop that has
    // already handed the goods over must not be able to give the voucher use back.
    await seedVoucher(shop, 'DONE1', { max_uses: 1 })

    const first = await placeOrder(shop, productId, 'DONE1', customerToken)
    const { id: orderId } = (await first.json()) as { id: string }

    expect((await patchOrder(shop, orderId, { status: 'completed' }, ownerToken)).status).toBe(200)

    const refused = await patchOrder(shop, orderId, { status: 'cancelled' }, ownerToken)
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: 'order_completed' })
    expect((await redemptionsOfOrder(orderId))[0].voided_at).toBeNull()

    // The slot never came back.
    const blocked = await placeOrder(shop, productId, 'DONE1', strangerToken)
    expect(blocked.status).toBe(409)
    expect(await blocked.json()).toEqual({ error: 'voucher_fully_used' })
  })

  it('leaves the redemption alone for a patch that is not a status change', async () => {
    await seedVoucher(shop, 'NOTE1', { max_uses: 1 })

    const first = await placeOrder(shop, productId, 'NOTE1', customerToken)
    const { id: orderId } = (await first.json()) as { id: string }

    expect((await patchOrder(shop, orderId, { note: 'ring the bell' }, ownerToken)).status).toBe(200)
    expect((await redemptionsOfOrder(orderId))[0].voided_at).toBeNull()
  })
})
