// tests/api/writes-orders.test.ts
// PATCH /api/merchants/:id/orders/:orderId — order status/note/tracking patch. The load-bearing
// assertion is tenancy: requireMerchantOwns only proves the caller owns :id — it says nothing
// about whether :orderId actually belongs to that shop. An owner of shop A nesting shop B's
// order under :id = A must be refused (404), not silently allowed to touch a stranger's row.
// See CLAUDE.md → Backend, Global Constraint 2.
import { describe, it, expect } from 'vitest'
import { app } from '../../src/app.js'
import { makeUser, seedMerchant, serviceClient, resetMerchant } from '../rls/helpers.js'

async function tokenOf(client: Awaited<ReturnType<typeof makeUser>>) {
  const { data } = await client.auth.getSession()
  return { token: data.session!.access_token, userId: data.session!.user.id }
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

type OrderRow = {
  id: string
  merchant_id: string
  status: string
  note: string | null
  courier: string | null
  awb: string | null
}

/** Seed one order for a merchant. Returns its id. */
async function seedOrder(fields: { merchant_id: string; order_number?: string; status?: string }) {
  const { data, error } = await serviceClient()
    .from('orders')
    .insert({
      merchant_id: fields.merchant_id,
      order_number: fields.order_number ?? `ORD-${crypto.randomUUID().slice(0, 8)}`,
      status: fields.status ?? 'new',
      customer_name: 'Ah Meng',
      customer_wa: '60123456789',
    })
    .select('id')
    .single()
  if (error) throw new Error(`seeding order: ${error.message}`)
  return data!.id as string
}

describe('PATCH /api/merchants/:id/orders/:orderId', () => {
  it('updates status for the owner', async () => {
    await resetMerchant('ord-owner-shop')
    const owner = await makeUser('ord-owner@example.com', 'password123')
    const { token, userId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'ord-owner-shop', owner_id: userId })
    const orderId = await seedOrder({ merchant_id: id })

    const res = await patch(`/api/merchants/${id}/orders/${orderId}`, { status: 'preparing' }, token)

    expect(res.status).toBe(200)
    const row = (await res.json()) as OrderRow
    expect(row.status).toBe('preparing')

    await serviceClient().from('orders').delete().eq('id', orderId)
    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('400s on an invalid status and leaves the row intact', async () => {
    await resetMerchant('ord-invalid-shop')
    const owner = await makeUser('ord-invalid@example.com', 'password123')
    const { token, userId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'ord-invalid-shop', owner_id: userId })
    const orderId = await seedOrder({ merchant_id: id })

    const res = await patch(`/api/merchants/${id}/orders/${orderId}`, { status: 'shipped' }, token)
    expect(res.status).toBe(400)

    const { data } = await serviceClient().from('orders').select('status').eq('id', orderId).single()
    expect(data!.status).toBe('new')

    await serviceClient().from('orders').delete().eq('id', orderId)
    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('updates note, courier and awb for the owner (trimmed, empty→null coercions applied)', async () => {
    await resetMerchant('ord-track-shop')
    const owner = await makeUser('ord-track@example.com', 'password123')
    const { token, userId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'ord-track-shop', owner_id: userId })
    const orderId = await seedOrder({ merchant_id: id })

    const res = await patch(`/api/merchants/${id}/orders/${orderId}`, {
      note: '  leave at the door  ',
      courier: 'jnt',
      awb: ' AWB123 ',
    }, token)

    expect(res.status).toBe(200)
    const row = (await res.json()) as OrderRow
    expect(row.note).toBe('leave at the door')
    expect(row.courier).toBe('jnt')
    expect(row.awb).toBe('AWB123')

    await serviceClient().from('orders').delete().eq('id', orderId)
    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('coerces an empty note/awb to null', async () => {
    await resetMerchant('ord-clear-shop')
    const owner = await makeUser('ord-clear@example.com', 'password123')
    const { token, userId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'ord-clear-shop', owner_id: userId })
    const orderId = await seedOrder({ merchant_id: id })

    const res = await patch(`/api/merchants/${id}/orders/${orderId}`, { note: '   ', awb: '  ' }, token)

    expect(res.status).toBe(200)
    const row = (await res.json()) as OrderRow
    expect(row.note).toBeNull()
    expect(row.awb).toBeNull()

    await serviceClient().from('orders').delete().eq('id', orderId)
    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('ignores a client-supplied merchant_id/total (allowlist guard)', async () => {
    await resetMerchant('ord-evil-shop')
    const owner = await makeUser('ord-evil@example.com', 'password123')
    const { token, userId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'ord-evil-shop', owner_id: userId })
    const orderId = await seedOrder({ merchant_id: id })

    const res = await patch(`/api/merchants/${id}/orders/${orderId}`, {
      status: 'preparing',
      total: 999999,
      merchant_id: '00000000-0000-0000-0000-000000000000',
      user_id: '00000000-0000-0000-0000-000000000000',
      order_number: 'HACKED',
    }, token)

    expect(res.status).toBe(200)
    const { data } = await serviceClient()
      .from('orders').select('merchant_id, total, order_number').eq('id', orderId).single()
    expect(data!.merchant_id).toBe(id)
    expect(data!.total).not.toBe(999999)
    expect(data!.order_number).not.toBe('HACKED')

    await serviceClient().from('orders').delete().eq('id', orderId)
    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('400s when no updatable fields are present', async () => {
    await resetMerchant('ord-empty-shop')
    const owner = await makeUser('ord-empty@example.com', 'password123')
    const { token, userId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'ord-empty-shop', owner_id: userId })
    const orderId = await seedOrder({ merchant_id: id })

    const res = await patch(`/api/merchants/${id}/orders/${orderId}`, { total: 999 }, token)
    expect(res.status).toBe(400)

    await serviceClient().from('orders').delete().eq('id', orderId)
    await serviceClient().from('merchants').delete().eq('id', id)
  })

  // Load-bearing: an owner of shop A cannot patch shop B's order by nesting it under :id = A.
  // requireMerchantOwns only proves ownership of :id; the handler must separately verify the
  // order's own merchant_id before updating it. See CLAUDE.md → Global Constraint 2.
  it('404s and leaves the row intact when the order belongs to a different shop', async () => {
    await resetMerchant('ord-tenant-a')
    await resetMerchant('ord-tenant-b')
    const ownerA = await makeUser('ord-tenant-a-owner@example.com', 'password123')
    const { token: tokenA, userId: ownerAId } = await tokenOf(ownerA)
    const shopA = await seedMerchant({ slug: 'ord-tenant-a', owner_id: ownerAId })

    const ownerB = await makeUser('ord-tenant-b-owner@example.com', 'password123')
    const { userId: ownerBId } = await tokenOf(ownerB)
    const shopB = await seedMerchant({ slug: 'ord-tenant-b', owner_id: ownerBId })
    const orderB = await seedOrder({ merchant_id: shopB, status: 'new' })

    const res = await patch(`/api/merchants/${shopA}/orders/${orderB}`, { status: 'completed' }, tokenA)
    expect(res.status).toBe(404)

    const { data } = await serviceClient()
      .from('orders').select('id, merchant_id, status').eq('id', orderB).single()
    expect(data!.merchant_id).toBe(shopB)
    expect(data!.status).toBe('new')

    await serviceClient().from('orders').delete().eq('id', orderB)
    await serviceClient().from('merchants').delete().eq('id', shopA)
    await serviceClient().from('merchants').delete().eq('id', shopB)
  })

  it('403 for a non-owner', async () => {
    await resetMerchant('ord-a-shop')
    const owner = await makeUser('ord-a-owner@example.com', 'password123')
    const { userId: ownerId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'ord-a-shop', owner_id: ownerId })
    const orderId = await seedOrder({ merchant_id: id })

    const other = await makeUser('ord-a-other@example.com', 'password123')
    const { token: otherToken } = await tokenOf(other)

    const res = await patch(`/api/merchants/${id}/orders/${orderId}`, { status: 'preparing' }, otherToken)
    expect(res.status).toBe(403)

    await serviceClient().from('orders').delete().eq('id', orderId)
    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('401 without a token', async () => {
    await resetMerchant('ord-anon-shop')
    const owner = await makeUser('ord-anon-owner@example.com', 'password123')
    const { userId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'ord-anon-shop', owner_id: userId })
    const orderId = await seedOrder({ merchant_id: id })

    const res = await patch(`/api/merchants/${id}/orders/${orderId}`, { status: 'preparing' })
    expect(res.status).toBe(401)

    await serviceClient().from('orders').delete().eq('id', orderId)
    await serviceClient().from('merchants').delete().eq('id', id)
  })
})
