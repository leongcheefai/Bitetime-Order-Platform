// tests/api/writes-merchants.test.ts
// POST /api/merchants — create-shop endpoint. The load-bearing assertion is that the
// handler forces status/owner_id server-side: the insert goes through `admin`
// (service_role), which BYPASSES guard_merchant_status, so if the handler ever spread a
// raw client body into .insert() a caller could self-activate their own shop or plant it
// under someone else's owner_id. See CLAUDE.md → Backend, Global Constraint 1.
import { describe, it, expect, beforeEach } from 'vitest'
import { app } from '../../src/app.js'
import { makeUser, seedMerchant, serviceClient, resetMerchant } from '../rls/helpers.js'

async function tokenOf(client: Awaited<ReturnType<typeof makeUser>>) {
  const { data } = await client.auth.getSession()
  return { token: data.session!.access_token, userId: data.session!.user.id }
}

function post(path: string, body: unknown, token?: string) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

function patch(path: string, body: unknown, token?: string) {
  return app.request(path, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

type MerchantRow = { id: string; slug: string; status: string; owner_id: string; order_prefix: string }

describe('POST /api/merchants', () => {
  it('creates a pending shop owned by the caller with a resolved slug', async () => {
    await resetMerchant('joe-coffee')
    const client = await makeUser('create-shop@example.com', 'password123')
    const { token, userId } = await tokenOf(client)

    const res = await post('/api/merchants', { name: 'Joe Coffee', plan: 'basic', billing: 'monthly', region: 'US' }, token)

    expect(res.status).toBe(200)
    const m = (await res.json()) as MerchantRow
    expect(m.slug).toBe('joe-coffee')
    expect(m.status).toBe('pending')
    expect(m.owner_id).toBe(userId)
    expect(m.order_prefix).toBe('JO')

    await serviceClient().from('merchants').delete().eq('id', m.id)
  })

  it('ignores a client-supplied status and owner_id (privilege guard)', async () => {
    await resetMerchant('evil-shop')
    const client = await makeUser('create-evil@example.com', 'password123')
    const { token, userId } = await tokenOf(client)

    const res = await post('/api/merchants', {
      name: 'Evil Shop',
      status: 'active',
      owner_id: '00000000-0000-0000-0000-000000000000',
    }, token)

    expect(res.status).toBe(200)
    const m = (await res.json()) as MerchantRow
    expect(m.status).toBe('pending')
    expect(m.owner_id).toBe(userId)

    await serviceClient().from('merchants').delete().eq('id', m.id)
  })

  it('suffixes a taken slug', async () => {
    await resetMerchant('taken-name-2')
    const ownerX = await makeUser('owner-x@example.com', 'password123')
    const { userId: ownerXId } = await tokenOf(ownerX)
    const takenId = await seedMerchant({ slug: 'taken-name', owner_id: ownerXId })

    const client = await makeUser('create-dup@example.com', 'password123')
    const { token } = await tokenOf(client)

    const res = await post('/api/merchants', { name: 'Taken Name' }, token)

    expect(res.status).toBe(200)
    const m = (await res.json()) as MerchantRow
    expect(m.slug).toBe('taken-name-2')

    await serviceClient().from('merchants').delete().eq('id', m.id)
    await serviceClient().from('merchants').delete().eq('id', takenId)
  })

  it('401 without a token', async () => {
    const res = await post('/api/merchants', {})
    expect(res.status).toBe(401)
  })
})

describe('PATCH /api/merchants/:id (config)', () => {
  it('updates allowlisted config for the owner', async () => {
    await resetMerchant('cfg-shop')
    const client = await makeUser('cfg-owner@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    const id = await seedMerchant({ slug: 'cfg-shop', owner_id: userId })

    const res = await patch(`/api/merchants/${id}`, { payment_note: 'Pay on pickup' }, token)

    expect(res.status).toBe(200)
    const m = (await res.json()) as { payment_note: string }
    expect(m.payment_note).toBe('Pay on pickup')

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('IGNORES status and owner_id in the body (no self-activation)', async () => {
    await resetMerchant('cfg-evil-shop')
    const client = await makeUser('cfg-evil@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    const id = await seedMerchant({ slug: 'cfg-evil-shop', owner_id: userId, status: 'suspended' })

    const res = await patch(`/api/merchants/${id}`, {
      status: 'active',
      owner_id: '00000000-0000-0000-0000-000000000000',
      payment_note: 'x',
    }, token)

    expect(res.status).toBe(200)

    // Load-bearing: read back with the service client, NOT the response body — the response
    // is what the handler returned, but the assertion that matters is what actually landed in
    // Postgres. The insert/update goes through `admin` (service_role), which bypasses
    // guard_merchant_status, so pickMerchantConfig is the ONLY thing standing between this body
    // and a self-activated suspended shop.
    const { data: row } = await serviceClient()
      .from('merchants').select('status, owner_id').eq('id', id).single()
    expect(row!.status).toBe('suspended')
    expect(row!.owner_id).toBe(userId)

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('403 for a non-owner', async () => {
    await resetMerchant('cfg-a-shop')
    const owner = await makeUser('cfg-a@example.com', 'password123')
    const { userId: ownerId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'cfg-a-shop', owner_id: ownerId })

    const other = await makeUser('cfg-b@example.com', 'password123')
    const { token: otherToken } = await tokenOf(other)

    const res = await patch(`/api/merchants/${id}`, { payment_note: 'x' }, otherToken)
    expect(res.status).toBe(403)

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('400 when no updatable fields are present', async () => {
    await resetMerchant('cfg-empty-shop')
    const client = await makeUser('cfg-empty@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    const id = await seedMerchant({ slug: 'cfg-empty-shop', owner_id: userId })

    const res = await patch(`/api/merchants/${id}`, { status: 'active', owner_id: 'x' }, token)
    expect(res.status).toBe(400)

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('401 without a token', async () => {
    await resetMerchant('cfg-anon-shop')
    const client = await makeUser('cfg-anon@example.com', 'password123')
    const { userId } = await tokenOf(client)
    const id = await seedMerchant({ slug: 'cfg-anon-shop', owner_id: userId })

    const res = await patch(`/api/merchants/${id}`, { payment_note: 'x' })
    expect(res.status).toBe(401)

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  // ── Tax settings (#88) — accepted from the owner, refused (never coerced) when invalid ──
  it('accepts tax settings from the owner', async () => {
    await resetMerchant('cfg-tax-shop')
    const client = await makeUser('cfg-tax@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    const id = await seedMerchant({ slug: 'cfg-tax-shop', owner_id: userId })

    const res = await patch(`/api/merchants/${id}`, { tax_enabled: true, tax_rate: 6 }, token)

    expect(res.status).toBe(200)
    const m = (await res.json()) as { tax_enabled: boolean; tax_rate: number }
    expect(m.tax_enabled).toBe(true)
    expect(Number(m.tax_rate)).toBe(6)

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('refuses a rate outside 0-100 instead of storing it', async () => {
    await resetMerchant('cfg-tax-hi-shop')
    const client = await makeUser('cfg-tax-hi@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    const id = await seedMerchant({ slug: 'cfg-tax-hi-shop', owner_id: userId })

    const res = await patch(`/api/merchants/${id}`, { tax_rate: 150 }, token)
    expect(res.status).toBe(400)

    // Load-bearing: read back with the service client, NOT just the response status — a
    // handler that stored 150 and THEN returned 400 would still pass a status-only assertion.
    const { data: row } = await serviceClient()
      .from('merchants').select('tax_rate').eq('id', id).single()
    expect(Number(row!.tax_rate)).toBe(0)

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('refuses a non-numeric rate', async () => {
    await resetMerchant('cfg-tax-nan-shop')
    const client = await makeUser('cfg-tax-nan@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    const id = await seedMerchant({ slug: 'cfg-tax-nan-shop', owner_id: userId })

    const res = await patch(`/api/merchants/${id}`, { tax_rate: 'six' }, token)
    expect(res.status).toBe(400)

    await serviceClient().from('merchants').delete().eq('id', id)
  })
})

describe('PATCH /api/merchants/:id/slug', () => {
  it('renames when the slug is free', async () => {
    await resetMerchant('old-slug')
    await resetMerchant('new-slug')
    const client = await makeUser('slug-owner@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    const id = await seedMerchant({ slug: 'old-slug', owner_id: userId })

    const res = await patch(`/api/merchants/${id}/slug`, { slug: 'new-slug' }, token)

    expect(res.status).toBe(200)
    const m = (await res.json()) as MerchantRow
    expect(m.slug).toBe('new-slug')

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('409 when the slug is taken by another merchant', async () => {
    await resetMerchant('busy')
    await resetMerchant('mine')
    const a = await makeUser('slug-a@example.com', 'password123')
    const { userId: aId } = await tokenOf(a)
    const busyId = await seedMerchant({ slug: 'busy', owner_id: aId })

    const b = await makeUser('slug-b@example.com', 'password123')
    const { token: bToken, userId: bId } = await tokenOf(b)
    const id = await seedMerchant({ slug: 'mine', owner_id: bId })

    const res = await patch(`/api/merchants/${id}/slug`, { slug: 'busy' }, bToken)
    expect(res.status).toBe(409)

    await serviceClient().from('merchants').delete().eq('id', id)
    await serviceClient().from('merchants').delete().eq('id', busyId)
  })

  it('400 on a reserved slug', async () => {
    await resetMerchant('res-shop')
    const client = await makeUser('slug-res@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    const id = await seedMerchant({ slug: 'res-shop', owner_id: userId })

    const res = await patch(`/api/merchants/${id}/slug`, { slug: 'admin' }, token)
    expect(res.status).toBe(400)

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('403 for a non-owner', async () => {
    await resetMerchant('slug-a-shop')
    const owner = await makeUser('slug-owner2@example.com', 'password123')
    const { userId: ownerId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'slug-a-shop', owner_id: ownerId })

    const other = await makeUser('slug-owner2-b@example.com', 'password123')
    const { token: otherToken } = await tokenOf(other)

    const res = await patch(`/api/merchants/${id}/slug`, { slug: 'whatever' }, otherToken)
    expect(res.status).toBe(403)

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('401 without a token', async () => {
    await resetMerchant('slug-anon-shop')
    const client = await makeUser('slug-anon@example.com', 'password123')
    const { userId } = await tokenOf(client)
    const id = await seedMerchant({ slug: 'slug-anon-shop', owner_id: userId })

    const res = await patch(`/api/merchants/${id}/slug`, { slug: 'whatever' })
    expect(res.status).toBe(401)

    await serviceClient().from('merchants').delete().eq('id', id)
  })
})

// ── Distance shipping policy (#101 Task 9) ──────────────────────────────────────
// One shop, re-seeded before every test so each case starts from the column defaults
// (shipping_mode 'region', no origin) regardless of what a prior case in this block saved.
describe('PATCH /api/merchants/:id (shipping policy)', () => {
  let merchantId: string
  let ownerToken: string

  beforeEach(async () => {
    await resetMerchant('cfg-shipping-shop')
    const client = await makeUser('cfg-shipping@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    merchantId = await seedMerchant({ slug: 'cfg-shipping-shop', owner_id: userId })
    ownerToken = token
  })

  function patchMerchant(id: string, token: string, body: unknown) {
    return patch(`/api/merchants/${id}`, body, token)
  }

  describe('shipping policy fields', () => {
    it('saves a complete distance policy', async () => {
      const res = await patchMerchant(merchantId, ownerToken, {
        shipping_mode: 'distance',
        delivery_base_fee: 6,
        delivery_rate_per_km: 1,
        delivery_max_km: 30,
        origin_place_id: 'ChIJorigin',
        origin_lat: 3.139003,
        origin_lng: 101.686855,
        origin_address: '12 Jalan Example, 50000 Kuala Lumpur',
      })
      expect(res.status).toBe(200)
    })

    it('refuses a negative base fee, rate or maximum — a typo must not make a delivery pay the customer', async () => {
      for (const patchBody of [{ delivery_base_fee: -1 }, { delivery_rate_per_km: -0.5 }, { delivery_max_km: -3 }]) {
        const res = await patchMerchant(merchantId, ownerToken, patchBody)
        expect(res.status).toBe(400)
      }
    })

    it('refuses a blank/whitespace string in a numeric field instead of coercing it to 0', async () => {
      // Number('') and Number('   ') are both 0 — the same trap tax_rate already guards against.
      // A caller that clears a numeric field and sends '' must not silently save a 0 fee.
      for (const patchBody of [{ delivery_base_fee: '' }, { delivery_rate_per_km: '   ' }, { delivery_max_km: '' }]) {
        const res = await patchMerchant(merchantId, ownerToken, patchBody)
        expect(res.status).toBe(400)
      }
    })

    it('refuses a maximum of zero, which is not "no limit"', async () => {
      const res = await patchMerchant(merchantId, ownerToken, { delivery_max_km: 0 })
      expect(res.status).toBe(400)
    })

    it('accepts a null maximum as "deliver anywhere with a road"', async () => {
      const res = await patchMerchant(merchantId, ownerToken, { delivery_max_km: null })
      expect(res.status).toBe(200)
    })

    it('refuses an unknown shipping mode', async () => {
      const res = await patchMerchant(merchantId, ownerToken, { shipping_mode: 'carrier_pigeon' })
      expect(res.status).toBe(400)
    })

    it('refuses switching to distance mode with no origin set', async () => {
      // Story 5: a merchant must not be able to half-configure their shop into quoting nothing.
      await patchMerchant(merchantId, ownerToken, { origin_place_id: null, shipping_mode: 'region' })
      const res = await patchMerchant(merchantId, ownerToken, { shipping_mode: 'distance' })
      expect(res.status).toBe(400)
    })

    it('refuses switching to distance mode when the patch explicitly nulls the origin in the same save', async () => {
      // The check must see the patch's own value, not just the row's stored origin. If a check
      // only reads the row's value and ignores the patch's explicit null, a rewritten code path
      // like `patch.origin_place_id ?? row.origin` would wrongly allow switching to distance
      // with an explicit null. This test catches that regression: first give the shop a real
      // origin, then try to null it and switch mode in the same save — the explicit null must win.
      const setupRes = await patchMerchant(merchantId, ownerToken, {
        shipping_mode: 'region',
        origin_place_id: 'ChIJorigin',
      })
      expect(setupRes.status).toBe(200)
      const res = await patchMerchant(merchantId, ownerToken, {
        shipping_mode: 'distance',
        origin_place_id: null,
      })
      expect(res.status).toBe(400)
    })

    it('allows switching to distance mode using an origin saved in an EARLIER save, without resending it', async () => {
      // The other half of "the check has to see the row's CURRENT origin as well as the
      // patch's": a merchant who sets their origin in one save and flips the mode in a LATER
      // save (never resending origin_place_id) must succeed — a check that only reads the
      // patch's own value, and never falls back to the row, would wrongly refuse this.
      await patchMerchant(merchantId, ownerToken, { origin_place_id: 'ChIJorigin', shipping_mode: 'region' })
      const res = await patchMerchant(merchantId, ownerToken, { shipping_mode: 'distance' })
      expect(res.status).toBe(200)
    })

    it('does not block a distance-mode shop from saving unrelated fields', async () => {
      // A merchant already on distance mode with an origin set must be able to save something
      // that has nothing to do with shipping (e.g. a payment note) without tripping the origin
      // check — it must only fire when the patch is actually TURNING ON distance mode.
      const setupRes = await patchMerchant(merchantId, ownerToken, {
        shipping_mode: 'distance',
        origin_place_id: 'ChIJorigin',
      })
      expect(setupRes.status).toBe(200)
      const res = await patchMerchant(merchantId, ownerToken, { payment_note: 'Ring the bell twice' })
      expect(res.status).toBe(200)
    })
  })
})
