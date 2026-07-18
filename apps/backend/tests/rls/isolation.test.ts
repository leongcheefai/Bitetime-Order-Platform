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

    // INSERT vector: explicit evil app_role must be overridden to 'customer'
    await merchantA.from('profiles').insert({ user_id: uid, app_role: 'superadmin' })
    const svc0 = serviceClient()
    const { data: insChk } = await svc0.from('profiles').select('app_role').eq('user_id', uid).single()
    expect(insChk!.app_role).toBe('customer')

    // UPDATE vector: cannot escalate to superadmin
    const { error } = await merchantA.from('profiles')
      .update({ app_role: 'superadmin' }).eq('user_id', uid)
    expect(error).not.toBeNull()                                       // raise exception => error
    const svc = serviceClient()
    const { data } = await svc.from('profiles').select('app_role').eq('user_id', uid).single()
    expect(data!.app_role).toBe('customer')
  })
})
