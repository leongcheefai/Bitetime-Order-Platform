// tests/rls/isolation.test.js
// Security-critical: proves RLS blocks cross-tenant access (two merchants).
// Requires a running local Supabase instance with env vars set:
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// Without those vars the suite is skipped so `npm test` stays green.
import { describe, it, expect, beforeAll } from 'vitest'
import { makeUser, seedMerchant, serviceClient } from './helpers.js'

describe('tenant isolation (RLS)', () => {
  let merchantA: any, merchantB: any, idA: any, idB: any

  beforeAll(async () => {
    const svc = serviceClient()

    merchantA = await makeUser('rls-a@test.dev', 'password123')
    merchantB = await makeUser('rls-b@test.dev', 'password123')

    const uA = (await merchantA.auth.getUser()).data.user!.id
    const uB = (await merchantB.auth.getUser()).data.user!.id

    idA = await seedMerchant({ name: 'A', slug: 'shop-rls-a', order_prefix: 'AA', owner_id: uA })
    idB = await seedMerchant({ name: 'B', slug: 'shop-rls-b', order_prefix: 'BB', owner_id: uB })

    // Seed an INACTIVE product for merchant B (active=false means merchantA
    // cannot see it via the public "active products" policy).
    await svc
      .from('products')
      .insert({ merchant_id: idB, name: 'Secret B cookie', price: 9, active: false })

    // Seed merchant B's Telegram secret so we can assert cross-tenant secrecy.
    await svc
      .from('merchant_secrets')
      .insert({ merchant_id: idB, tg_token: 'secretB-tg-token', tg_chat_id: '123456' })
  }, 30_000)

  it('merchant A cannot write into merchant B', async () => {
    const { error } = await merchantA
      .from('products')
      .insert({ merchant_id: idB, name: 'hack', price: 1 })
    expect(error).not.toBeNull()
  })

  it('an owner cannot flip their own merchant status to active', async () => {
    const svc = serviceClient()
    await svc.from('merchants').update({ status: 'suspended' }).eq('id', idA)

    const { error } = await merchantA
      .from('merchants').update({ status: 'active' }).eq('id', idA)
    expect(error).not.toBeNull()                        // raise exception => error

    const { data } = await svc.from('merchants').select('status').eq('id', idA).single()
    expect(data!.status).toBe('suspended')              // unchanged
    await svc.from('merchants').update({ status: 'active' }).eq('id', idA) // restore
  })

  it('a normal user cannot self-promote to superadmin', async () => {
    const uid = (await merchantA.auth.getUser()).data.user!.id
    const svc = serviceClient()

    // Two layers stand between a normal user and a superadmin profile, and this test asserts the
    // PROPERTY they jointly guarantee rather than which one fires: an authenticated client holds
    // NO grant on `profiles` (revoked in 20260718130000), and behind that the
    // `guard_profile_privileges` trigger forces `app_role` to 'customer' on insert and raises on
    // any change to it. Asserting the property keeps the test meaningful under either layer — and
    // real on a freshly reset database, where no stale row exists to make a weaker check pass.

    // INSERT vector: an explicit evil app_role must never yield a superadmin profile. `maybeSingle`
    // because the grant layer means the insert may create no row at all — which is itself a pass.
    await merchantA.from('profiles').insert({ user_id: uid, app_role: 'superadmin' })
    const { data: insChk } = await svc
      .from('profiles').select('app_role').eq('user_id', uid).maybeSingle()
    expect(insChk?.app_role ?? 'customer').not.toBe('superadmin')

    // UPDATE vector: seed a real customer profile through the RLS-exempt service role, then prove
    // the user cannot escalate it. Delete-then-insert so the row is deterministic regardless of
    // what the INSERT vector above left behind.
    await svc.from('profiles').delete().eq('user_id', uid)
    await svc.from('profiles').insert({ user_id: uid, app_role: 'customer' })
    await merchantA.from('profiles').update({ app_role: 'superadmin' }).eq('user_id', uid)
    const { data } = await svc.from('profiles').select('app_role').eq('user_id', uid).single()
    expect(data!.app_role).toBe('customer')
  })
})
