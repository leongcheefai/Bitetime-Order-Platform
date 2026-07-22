// tests/api/shippingQuote.test.ts
// POST /api/shipping/quote — the wire contract for a distance quote, driven in-process against
// real Postgres.
//
// Every case here is priced from a SEEDED CACHE ROW. That is what keeps Google out of this
// suite entirely: the endpoint's own rule is "cache first", so a seeded row is a complete,
// honest exercise of the path a real customer takes a second after their address resolves.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { app } from '../../src/app.js'
import { makeUser, resetMerchant, seedMerchant, serviceClient } from '../rls/helpers.js'

const SLUGS = ['q-distance', 'q-region', 'q-suspended']
const ORIGIN = 'ChIJq-origin'
const DEST = 'ChIJq-dest'
const FAR = 'ChIJq-far'
const UNKNOWN = 'ChIJq-unknown'

const svc = () => serviceClient()

let distanceId = ''
let regionId = ''
let suspendedId = ''

function post(payload: unknown) {
  return app.request('/api/shipping/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

async function seedQuote(destination: string, metres: number) {
  await svc().from('distance_quotes').upsert({
    origin_place_id: ORIGIN,
    destination_place_id: destination,
    metres,
    created_at: new Date().toISOString(),
  })
}

beforeAll(async () => {
  // Three owners, not one — `merchants.owner_id` is UNIQUE (one shop per owner), so the
  // distance-priced, region-priced and suspended fixtures each need their own.
  const distanceOwner = await makeUser('quote-owner-distance@test.local', 'password123')
  const regionOwner = await makeUser('quote-owner-region@test.local', 'password123')
  const suspendedOwner = await makeUser('quote-owner-suspended@test.local', 'password123')
  const distanceOwnerId = (await distanceOwner.auth.getUser()).data.user!.id
  const regionOwnerId = (await regionOwner.auth.getUser()).data.user!.id
  const suspendedOwnerId = (await suspendedOwner.auth.getUser()).data.user!.id
  distanceId = await seedMerchant({
    slug: 'q-distance', owner_id: distanceOwnerId, order_prefix: 'QD',
    shipping_mode: 'distance', delivery_base_fee: 6, delivery_rate_per_km: 1,
    delivery_max_km: 30, origin_place_id: ORIGIN,
  })
  regionId = await seedMerchant({ slug: 'q-region', owner_id: regionOwnerId, order_prefix: 'QR' })
  suspendedId = await seedMerchant({
    slug: 'q-suspended', owner_id: suspendedOwnerId, order_prefix: 'QS', status: 'suspended',
    // A suspended shop still needs `origin_place_id` set, or the distance-mode CHECK constraint
    // rejects the row (shipping_mode <> 'distance' or origin_place_id is not null).
    shipping_mode: 'distance', delivery_base_fee: 6, delivery_rate_per_km: 1,
    delivery_max_km: 30, origin_place_id: ORIGIN,
  })
  await seedQuote(DEST, 25216)
  await seedQuote(FAR, 45000)
})

afterAll(async () => {
  for (const slug of SLUGS) await resetMerchant(slug)
  for (const d of [DEST, FAR, UNKNOWN]) {
    await svc().from('distance_quotes').delete()
      .eq('origin_place_id', ORIGIN).eq('destination_place_id', d)
  }
})

describe('POST /api/shipping/quote', () => {
  it('returns the routed km and the fee for a cached pair', async () => {
    const res = await post({ merchantId: distanceId, placeId: DEST })
    expect(res.status).toBe(200)
    // The reference pair: 25216 m at 6.00 + 1.00/km.
    expect(await res.json()).toMatchObject({ km: 25.2, fee: 31.2 })
  })

  it('refuses a body with no place id at all', async () => {
    // Free text would let a caller mint unlimited DISTINCT destinations, and every distinct
    // destination is a billable lookup on the platform's own Maps account.
    const res = await post({ merchantId: distanceId, address: '12 Jalan Example, Kuala Lumpur' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_body' })
  })

  it('takes free text in the placeId field at face value — the ceiling is what bounds the cost', async () => {
    // NOT a hole, and NOT an invitation to add format validation. Google place ids have no
    // stable public shape (`ChIJ…`, `Eh…`, `GhIJ…` are all real), so a shape check would refuse
    // legitimate addresses — a customer told their own address is invalid. What actually bounds
    // "mint unlimited billable destinations" is the per-merchant daily ceiling and the IP window,
    // and they bound it whether the input is a real place id or not.
    //
    // With no cache row and no Maps key in this suite's env, the lookup cannot happen, so this
    // arrives at the retryable refusal rather than a fee.
    const res = await post({ merchantId: distanceId, placeId: '12 Jalan Example, Kuala Lumpur' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'lookup_failed' })
  })

  it('refuses a quote at a suspended shop', async () => {
    const res = await post({ merchantId: suspendedId, placeId: DEST })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'merchant_inactive' })
  })

  it('refuses a destination beyond the shop maximum, with the out-of-range reason', async () => {
    const res = await post({ merchantId: distanceId, placeId: FAR })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'out_of_range' })
  })

  it('refuses a quote at a region-priced shop', async () => {
    const res = await post({ merchantId: regionId, placeId: DEST })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'not_distance_priced' })
  })

  it('404s an unknown shop', async () => {
    const res = await post({ merchantId: '00000000-0000-0000-0000-000000000000', placeId: DEST })
    expect(res.status).toBe(404)
  })

  it('reports a lookup failure as retryable, distinct from out-of-range', async () => {
    // No cache row and no Maps key in the test env, so the adapter reports `failed`.
    const res = await post({ merchantId: distanceId, placeId: UNKNOWN })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'lookup_failed' })
  })
})
