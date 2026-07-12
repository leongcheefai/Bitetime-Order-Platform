// tests/rls/order-attribution.test.ts
// Security-critical: proves the DATABASE decides who an order belongs to.
//
// The client never supplies user_id — a BEFORE INSERT trigger stamps it from
// auth.uid(). Signed in => their id. Guest (no JWT) => NULL. A client that
// tries to attach an order to someone else's account has that id discarded.
//
// Requires a running local Supabase with env vars set:
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// Without those vars the suite is skipped so `test` stays green.
import { describe, it, expect, beforeAll } from 'vitest'
import { anonClient, makeUser, seedMerchant, serviceClient } from './helpers.js'

/** A minimal order, shaped like the one the storefront inserts. */
function order(merchantId: string, extra: Record<string, unknown> = {}) {
  return {
    merchant_id: merchantId,
    customer_name: 'Ah Meng',
    customer_wa: '60123456789',
    mode: 'pickup',
    items: [{ id: 'p1', name: 'Matcha Cookie', qty: 1, price: 13 }],
    total: 13,
    status: 'new',
    ...extra,
  }
}

describe('order attribution (RLS + trigger)', () => {
  let customerA: any, customerB: any
  let userA: string, userB: string
  let activeShop: string, pendingShop: string, suspendedShop: string
  let merchantOwner: any

  beforeAll(async () => {
    customerA = await makeUser('attr-customer-a@test.dev', 'password123')
    customerB = await makeUser('attr-customer-b@test.dev', 'password123')
    merchantOwner = await makeUser('attr-merchant@test.dev', 'password123')
    const closedShopsOwner = await makeUser('attr-merchant-closed@test.dev', 'password123')

    userA = (await customerA.auth.getUser()).data.user!.id
    userB = (await customerB.auth.getUser()).data.user!.id
    const owner = (await merchantOwner.auth.getUser()).data.user!.id
    const otherOwner = (await closedShopsOwner.auth.getUser()).data.user!.id

    // The closed shops get a DIFFERENT owner on purpose: current_merchant_id()
    // is `select id from merchants where owner_id = auth.uid() limit 1`, so an
    // owner holding several shops resolves to an arbitrary one of them and the
    // merchant read-back below would silently look at the wrong shop.
    activeShop = await seedMerchant({ slug: 'attr-active', order_prefix: 'AT', owner_id: owner })
    pendingShop = await seedMerchant({ slug: 'attr-pending', order_prefix: 'AT', owner_id: otherOwner, status: 'pending' })
    suspendedShop = await seedMerchant({ slug: 'attr-suspended', order_prefix: 'AT', owner_id: otherOwner, status: 'suspended' })
  }, 30_000)

  // ── The trigger stamps the ordering user ───────────────────────────────────

  it('stamps a signed-in customer’s own id on their order', async () => {
    const { data, error } = await customerA
      .from('orders')
      .insert(order(activeShop, { order_number: 'AT-1' }))
      .select('user_id')
      .single()

    expect(error).toBeNull()
    expect(data!.user_id).toBe(userA)
  })

  it('leaves a guest order unattributed', async () => {
    const anon = anonClient()
    const { error } = await anon.from('orders').insert(order(activeShop, { order_number: 'AT-2' }))
    expect(error).toBeNull()

    // Only the service role can look: the guest cannot read its own order back.
    const { data } = await serviceClient()
      .from('orders').select('user_id').eq('order_number', 'AT-2').single()
    expect(data!.user_id).toBeNull()
  })

  it('discards a user_id supplied by an anonymous client', async () => {
    const anon = anonClient()
    const { error } = await anon
      .from('orders')
      .insert(order(activeShop, { order_number: 'AT-3', user_id: userA }))
    expect(error).toBeNull()

    const { data } = await serviceClient()
      .from('orders').select('user_id').eq('order_number', 'AT-3').single()
    expect(data!.user_id).toBeNull()
  })

  // THE test. If this ever fails, the feature is a vulnerability: anyone could
  // push orders into a stranger's history.
  it('discards a user_id belonging to somebody else', async () => {
    const { data, error } = await customerA
      .from('orders')
      .insert(order(activeShop, { order_number: 'AT-4', user_id: userB }))
      .select('user_id')
      .single()

    expect(error).toBeNull()
    expect(data!.user_id).toBe(userA)
    expect(data!.user_id).not.toBe(userB)
  })

  // ── The insert policy ──────────────────────────────────────────────────────
  // Assert the RLS code (42501), not merely "an error": a fixture typo or a FK
  // violation would satisfy a bare not.toBeNull() just as happily, and the test
  // would keep passing with the policy dropped.

  it('rejects an order into a pending shop', async () => {
    const { error } = await customerA
      .from('orders')
      .insert(order(pendingShop, { order_number: 'AT-5' }))
    expect(error?.code).toBe('42501')
  })

  it('rejects an order into a suspended shop', async () => {
    const { error } = await anonClient()
      .from('orders')
      .insert(order(suspendedShop, { order_number: 'AT-6' }))
    expect(error?.code).toBe('42501')
  })

  it('rejects an order that is born already completed', async () => {
    const { error } = await customerA
      .from('orders')
      .insert(order(activeShop, { order_number: 'AT-7', status: 'completed' }))
    expect(error?.code).toBe('42501')
  })

  // ── The storefront's actual path ───────────────────────────────────────────

  // placeOrder takes a number from the next_order_number RPC, then inserts with
  // it. Both halves have to stay open to an anonymous client, or guest checkout
  // dies — and neither the mocked store.test.ts nor the hand-written order
  // numbers above would notice.
  it('lets a guest take an order number and place the order with it', async () => {
    const anon = anonClient()

    const { data: orderNumber, error: rpcError } = await anon
      .rpc('next_order_number', { p_merchant: activeShop })
    expect(rpcError).toBeNull()
    expect(orderNumber).toMatch(/^AT-\d{6}-\d{4}$/)

    const { error } = await anon.from('orders').insert(order(activeShop, { order_number: orderNumber }))
    expect(error).toBeNull()

    const { data } = await serviceClient()
      .from('orders').select('user_id').eq('order_number', orderNumber).single()
    expect(data!.user_id).toBeNull()
  })

  // ── Reads ──────────────────────────────────────────────────────────────────

  it('lets a customer read their own orders', async () => {
    const { data, error } = await customerA.from('orders').select('order_number')
    expect(error).toBeNull()
    expect(data!.map((o: any) => o.order_number)).toContain('AT-1')
  })

  it('does not let a customer read somebody else’s orders', async () => {
    const { data, error } = await customerB.from('orders').select('order_number')
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('lets a guest read nothing, even the order it just placed', async () => {
    const anon = anonClient()
    await anon.from('orders').insert(order(activeShop, { order_number: 'AT-8' }))

    const { data, error } = await anon.from('orders').select('order_number')
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('still lets the merchant read every order at their shop, guest ones included', async () => {
    const { data, error } = await merchantOwner
      .from('orders').select('order_number, user_id').eq('merchant_id', activeShop)

    expect(error).toBeNull()
    const numbers = data!.map((o: any) => o.order_number)
    expect(numbers).toContain('AT-1') // the signed-in customer's
    expect(numbers).toContain('AT-2') // a guest's
  })
})
