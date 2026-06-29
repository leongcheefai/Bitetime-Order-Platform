// tests/rls/isolation.test.js
// Security-critical: proves RLS blocks cross-tenant access (two merchants).
// Requires a running local Supabase instance with env vars set:
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// Without those vars the suite is skipped so `npm test` stays green.
import { describe, it, expect, beforeAll } from 'vitest'
import { hasEnv, makeUser, serviceClient } from './helpers.js'

describe.skipIf(!hasEnv)('tenant isolation (RLS)', () => {
  let merchantA: any, merchantB: any, idA: any, idB: any

  beforeAll(async () => {
    const svc = serviceClient()

    merchantA = await makeUser('rls-a@test.dev', 'password123')
    merchantB = await makeUser('rls-b@test.dev', 'password123')

    const uA = (await merchantA.auth.getUser()).data.user!.id
    const uB = (await merchantB.auth.getUser()).data.user!.id

    // Insert merchant A (owned by uA)
    const resA = await svc
      .from('merchants')
      .insert({ name: 'A', slug: 'shop-rls-a', order_prefix: 'AA', owner_id: uA, status: 'active' })
      .select('id')
      .single()
    idA = resA.data!.id

    // Insert merchant B (owned by uB)
    const resB = await svc
      .from('merchants')
      .insert({ name: 'B', slug: 'shop-rls-b', order_prefix: 'BB', owner_id: uB, status: 'active' })
      .select('id')
      .single()
    idB = resB.data!.id

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

  it('merchant A cannot read merchant B inactive products', async () => {
    const { data, error } = await merchantA.from('products').select('*').eq('merchant_id', idB)
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('merchant A cannot write into merchant B', async () => {
    const { error } = await merchantA
      .from('products')
      .insert({ merchant_id: idB, name: 'hack', price: 1 })
    expect(error).not.toBeNull()
  })

  it('merchant A can write into its own tenant', async () => {
    const { error } = await merchantA
      .from('products')
      .insert({ merchant_id: idA, name: 'A cookie', price: 5 })
    expect(error).toBeNull()
  })

  it('merchant A cannot read merchant B merchant_secrets', async () => {
    const { data, error } = await merchantA
      .from('merchant_secrets')
      .select('*')
      .eq('merchant_id', idB)
    // RLS should return empty, not an error (postgres hides rows silently).
    expect(error).toBeNull()
    expect(data).toEqual([])
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
