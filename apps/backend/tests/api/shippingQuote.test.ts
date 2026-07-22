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

const SLUGS = ['q-distance', 'q-region']
const ORIGIN = 'ChIJq-origin'
const DEST = 'ChIJq-dest'
const FAR = 'ChIJq-far'
const UNKNOWN = 'ChIJq-unknown'

const svc = () => serviceClient()

let distanceId = ''
let regionId = ''

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
  // Two owners, not one — `merchants.owner_id` is UNIQUE (one shop per owner), so the
  // distance-priced and region-priced fixtures each need their own.
  const distanceOwner = await makeUser('quote-owner-distance@test.local', 'password123')
  const regionOwner = await makeUser('quote-owner-region@test.local', 'password123')
  const distanceOwnerId = (await distanceOwner.auth.getUser()).data.user!.id
  const regionOwnerId = (await regionOwner.auth.getUser()).data.user!.id
  distanceId = await seedMerchant({
    slug: 'q-distance', owner_id: distanceOwnerId, order_prefix: 'QD',
    shipping_mode: 'distance', delivery_base_fee: 6, delivery_rate_per_km: 1,
    delivery_max_km: 30, origin_place_id: ORIGIN,
  })
  regionId = await seedMerchant({ slug: 'q-region', owner_id: regionOwnerId, order_prefix: 'QR' })
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

  it('refuses a free-text destination — a place id is the only accepted input', async () => {
    // Free text would let a caller mint unlimited DISTINCT destinations, and every distinct
    // destination is a billable lookup on the platform's own Maps account.
    const res = await post({ merchantId: distanceId, address: '12 Jalan Example, Kuala Lumpur' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_body' })
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
