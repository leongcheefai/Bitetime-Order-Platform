// tests/rls/order-attribution.test.ts
// Security-critical: proves the browser CANNOT insert an order, and reads stay scoped.
//
// This suite used to prove that the database decided who an order belonged to, by inserting
// as an anon/authenticated client and watching a BEFORE INSERT trigger stamp auth.uid() over
// whatever the client sent. Order intake now runs in the backend (#65), and the premise has
// inverted:
//
//   * anon and authenticated no longer hold INSERT on orders. There is no client insert left
//     to stamp, and the tests that drove one are gone with it.
//   * The orders_set_user_id trigger now COALESCEs instead of overwriting — it has to, since
//     there is no auth.uid() on the backend's direct connection. That reopens the spoofing
//     hole the unconditional assignment closed, and THE REVOKE IS THE ONLY THING SHUTTING IT.
//     So the revoke is what this file now guards, and it guards it hard: if a future migration
//     grants INSERT back to a client role, the first test here fails and says why.
//
// Attribution itself (JWT decides, body is ignored) is proven where it now lives, against the
// real endpoint: tests/api/orders.test.ts.
//
// Requires a running local Supabase — see vitest.db.config.ts.
import { describe, it, expect, beforeAll } from 'vitest'
import { anonClient, makeUser, seedMerchant, serviceClient } from './helpers.js'

/** A minimal order, shaped like the one intake writes. */
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

describe('order intake is closed to the browser (RLS + grants)', () => {
  let customerA: any, customerB: any
  let userA: string
  let activeShop: string
  let merchantOwner: any

  beforeAll(async () => {
    customerA = await makeUser('attr-customer-a@test.dev', 'password123')
    customerB = await makeUser('attr-customer-b@test.dev', 'password123')
    merchantOwner = await makeUser('attr-merchant@test.dev', 'password123')

    userA = (await customerA.auth.getUser()).data.user!.id
    const owner = (await merchantOwner.auth.getUser()).data.user!.id

    activeShop = await seedMerchant({ slug: 'attr-active', order_prefix: 'AT', owner_id: owner })

    // The read fixtures are seeded with the SERVICE ROLE, because that is now the only thing
    // that can write an order — which is the whole point of the suite. One attributed order,
    // one guest order.
    const svc = serviceClient()
    const { error } = await svc.from('orders').insert([
      order(activeShop, { order_number: 'AT-1', user_id: userA }),
      order(activeShop, { order_number: 'AT-2', user_id: null }),
    ])
    if (error) throw new Error(`seeding orders: ${error.message}`)
  }, 30_000)

  // ── The door is shut ────────────────────────────────────────────────────────
  // Assert the grant/RLS code (42501), never a bare "an error happened": a fixture typo or an
  // FK violation would satisfy `not.toBeNull()` just as happily, and the test would keep
  // passing with the door wide open.

  it('refuses an order insert from an anonymous client', async () => {
    const { error } = await anonClient().from('orders').insert(order(activeShop, { order_number: 'AT-X1' }))

    expect(error?.code).toBe('42501')
  })

  it('refuses an order insert from a signed-in customer', async () => {
    const { error } = await customerA.from('orders').insert(order(activeShop, { order_number: 'AT-X2' }))

    expect(error?.code).toBe('42501')
  })

  // THE test. The trigger no longer discards a client-supplied user_id — it keeps it. The only
  // reason that is not a vulnerability is this refusal. If it ever passes, anyone holding the
  // anon key (it ships in every browser) can push orders into a stranger's history.
  it('refuses an insert carrying somebody else’s user_id — the revoke, not the trigger, is what stops it', async () => {
    const { error } = await anonClient()
      .from('orders')
      .insert(order(activeShop, { order_number: 'AT-X3', user_id: userA }))

    expect(error?.code).toBe('42501')

    const { data } = await serviceClient().from('orders').select('id').eq('order_number', 'AT-X3')
    expect(data).toEqual([])
  })

  // The two RPCs the backend took over. Leaving next_order_number executable would let anyone
  // burn a shop's daily counter; leaving redeem_voucher executable would let anyone mark a
  // stranger's voucher used.
  //
  // PGRST202 is "no such function", and asserting it is the whole point: calling a function
  // with no arguments errors whether or not it still exists, so a bare `not.toBeNull()` would
  // pass with both functions alive and grants intact — exactly the trap this file warns about
  // eight lines above.
  it.each(['next_order_number', 'redeem_voucher'])('no longer exposes the %s function', async (fn) => {
    const { error } = await anonClient().rpc(fn, {})

    expect(error?.code).toBe('PGRST202')
  })

  // ── Reads are unchanged ────────────────────────────────────────────────────

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

  it('lets a guest read nothing', async () => {
    const { data, error } = await anonClient().from('orders').select('order_number')

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
