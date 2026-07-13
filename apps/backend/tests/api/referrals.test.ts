// tests/api/referrals.test.ts
// The first suite to drive the Hono app in-process, through app.request().
//
// It replaces the my_referred_shops SECURITY DEFINER function, whose whole job was to
// filter by the CALLER's own referral code — derived in SQL from auth.uid(), never from
// anything the client sent. That property is the one worth testing: the code must stay
// derived from the verified JWT, so no request body or query string can talk the endpoint
// into listing someone else's referrals.
//
// Runs against a real local Supabase. Never mocked — see vitest.db.config.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { app } from '../../src/app.js'
import { listReferredShops, type ReferredShop } from '../../src/referrals.js'
import { makeUser, seedMerchant, serviceClient } from '../rls/helpers.js'

const SLUGS = ['ref-older', 'ref-newer', 'ref-none']

/** The same derivation the frontend's referralCodeOf() does: first 8 hex chars, uppercased. */
function referralCodeOf(userId: string) {
  return userId.replace(/-/g, '').slice(0, 8).toUpperCase()
}

async function tokenFor(client: Awaited<ReturnType<typeof makeUser>>) {
  const { data } = await client.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('signed-in client returned no access token')
  return token
}

function get(token?: string) {
  return app.request('/api/referrals/shops', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
}

const shopsIn = (res: Response) => res.json() as Promise<ReferredShop[]>

describe('GET /api/referrals/shops', () => {
  let referrerToken: string
  let strangerToken: string
  let referrerCode: string
  let referrerId: string

  beforeAll(async () => {
    const referrer = await makeUser('referrer@example.com', 'password123')
    const stranger = await makeUser('stranger@example.com', 'password123')
    // A referred shop belongs to the person who was referred, never to the referrer — that
    // is what makes this a cross-tenant read and the reason the old function needed SECURITY
    // DEFINER. Seeding all three under one owner would also be a state the app cannot
    // represent: it resolves a merchant's own shop expecting exactly one per owner.
    const invitedA = await makeUser('invited-a@example.com', 'password123')
    const invitedB = await makeUser('invited-b@example.com', 'password123')

    const { data: ref } = await referrer.auth.getUser()
    referrerId = ref.user!.id
    referrerCode = referralCodeOf(referrerId)

    referrerToken = await tokenFor(referrer)
    strangerToken = await tokenFor(stranger)

    const owner = async (c: typeof invitedA) => (await c.auth.getUser()).data.user!.id

    // Two shops signed up under the referrer's code; one under nobody's.
    const older = await seedMerchant({ slug: 'ref-older', owner_id: await owner(invitedA), name: 'Older Shop', status: 'active' })
    const newer = await seedMerchant({ slug: 'ref-newer', owner_id: await owner(invitedB), name: 'Newer Shop', status: 'pending' })
    const unrelated = await seedMerchant({ slug: 'ref-none', owner_id: ref.user!.id, name: 'Unrelated Shop' })

    const svc = serviceClient()
    // Stamp created_at explicitly so "newest first" is asserted against a known order
    // rather than whichever insert happened to win the clock.
    await svc.from('merchants').update({ referred_by_code: referrerCode, created_at: '2026-01-01T00:00:00Z' }).eq('id', older)
    await svc.from('merchants').update({ referred_by_code: referrerCode, created_at: '2026-06-01T00:00:00Z' }).eq('id', newer)
    await svc.from('merchants').update({ referred_by_code: null }).eq('id', unrelated)
  })

  // Leave the local database as we found it. seedMerchant() clears by slug on the way in, so
  // a re-run works either way — but a developer's stack should not silently accumulate three
  // fixture shops every time the suite runs.
  afterAll(async () => {
    await serviceClient().from('merchants').delete().in('slug', SLUGS)
  })

  it('lists the shops that signed up under the caller’s code, newest first', async () => {
    const res = await get(referrerToken)
    expect(res.status).toBe(200)

    const shops = await shopsIn(res)
    expect(shops.map(s => s.name)).toEqual(['Newer Shop', 'Older Shop'])
  })

  it('returns name, created_at and status for each shop — and nothing else', async () => {
    const res = await get(referrerToken)
    const [first] = await shopsIn(res)

    expect(first).toEqual({
      name: 'Newer Shop',
      created_at: '2026-06-01T00:00:00.000Z',
      status: 'pending',
    })
  })

  // The one thing the HTTP seam cannot see, so the only reason this file reaches past it.
  //
  // postgres.js returns a Date for timestamptz, and `sql<T[]>` is an unchecked assertion — so
  // tsc will happily believe a declared `created_at: string` that is really a Date. Over HTTP
  // the lie is invisible: c.json() stringifies a Date to the identical ISO text, so an
  // assertion on the response body passes whether or not the module ever converted it
  // (verified — removing the conversion does not fail the test above). A backend caller who
  // trusts the type and does `created_at.slice(...)` is the one who finds out.
  it('hands back created_at as a real string, not the driver’s Date', async () => {
    const [first] = await listReferredShops(referrerId)

    expect(typeof first.created_at).toBe('string')
  })

  it('omits shops that signed up under nobody’s code', async () => {
    const res = await get(referrerToken)
    const shops = await shopsIn(res)

    expect(shops.map(s => s.name)).not.toContain('Unrelated Shop')
  })

  it('shows a stranger none of the referrer’s shops', async () => {
    const res = await get(strangerToken)

    expect(res.status).toBe(200)
    expect(await shopsIn(res)).toEqual([])
  })

  it('rejects an anonymous caller', async () => {
    const res = await get()

    expect(res.status).toBe(401)
  })

  it('rejects a garbage token', async () => {
    const res = await get('not-a-real-jwt')

    expect(res.status).toBe(401)
  })

  // The reason the code is derived server-side from the JWT and never read from the
  // request. If this ever passes with the stranger seeing the referrer's shops, the
  // endpoint has been talked into impersonation.
  it('ignores a referral code supplied by the caller', async () => {
    const res = await app.request(`/api/referrals/shops?code=${referrerCode}`, {
      headers: { Authorization: `Bearer ${strangerToken}` },
    })

    expect(res.status).toBe(200)
    expect(await shopsIn(res)).toEqual([])
  })
})
