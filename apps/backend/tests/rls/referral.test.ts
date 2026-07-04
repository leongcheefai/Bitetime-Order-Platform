// Security-critical: proves referral capture + track only ever exposes a referrer's own
// invited shops (three safe columns), never others'. Requires a running local Supabase
// with SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY set.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { hasEnv, makeUser, serviceClient } from './helpers.js'

// Same derivation as referralCodeOf() in the frontend store.
const codeOf = (uid: string) => uid.replace(/-/g, '').slice(0, 8).toUpperCase()

const SLUGS = ['ref-shop-a', 'ref-shop-b', 'ref-shop-c']

describe.skipIf(!hasEnv)('referral capture & track (RLS)', () => {
  let userA: any, userC: any
  let uA: string

  beforeAll(async () => {
    const svc = serviceClient()

    // Idempotent: clear any rows left by a prior/crashed run before seeding, so the
    // "C sees none" assertion and the unique-slug inserts don't depend on run order.
    await svc.from('merchants').delete().in('slug', SLUGS)

    userA = await makeUser('ref-a@test.dev', 'password123')
    const userB = await makeUser('ref-b@test.dev', 'password123')
    userC = await makeUser('ref-c@test.dev', 'password123')

    uA = (await userA.auth.getUser()).data.user!.id
    const uB = (await userB.auth.getUser()).data.user!.id
    const uC = (await userC.auth.getUser()).data.user!.id

    // A is the referrer.
    await svc.from('merchants').insert({ name: 'Shop A', slug: 'ref-shop-a', order_prefix: 'RA', owner_id: uA, status: 'active' })
    // B signed up with A's code.
    await svc.from('merchants').insert({ name: 'Shop B', slug: 'ref-shop-b', order_prefix: 'RB', owner_id: uB, status: 'pending', referred_by_code: codeOf(uA) })
    // C is unrelated (no referral).
    await svc.from('merchants').insert({ name: 'Shop C', slug: 'ref-shop-c', order_prefix: 'RC', owner_id: uC, status: 'active' })
  }, 30_000)

  afterAll(async () => {
    await serviceClient().from('merchants').delete().in('slug', SLUGS)
  })

  it('referrer A sees shop B with its name, date and status', async () => {
    const { data, error } = await userA.rpc('my_referred_shops')
    expect(error).toBeNull()
    const b = data.find((r: any) => r.name === 'Shop B')
    expect(b).toBeTruthy()
    expect(b.status).toBe('pending')
    expect(b.created_at).toBeTruthy()
    // Only the three safe columns are returned.
    expect(Object.keys(b).sort()).toEqual(['created_at', 'name', 'status'])
  })

  it('unrelated user C sees no referred shops', async () => {
    const { data, error } = await userC.rpc('my_referred_shops')
    expect(error).toBeNull()
    expect(data).toEqual([])
  })
})
