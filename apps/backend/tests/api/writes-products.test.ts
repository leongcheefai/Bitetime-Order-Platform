// tests/api/writes-products.test.ts
// PUT/DELETE /api/merchants/:id/products/:productId — product upsert/delete. The load-bearing
// assertion is tenancy: requireMerchantOwns only proves the caller owns :id — it says nothing
// about whether :productId actually belongs to that shop. An owner of shop A nesting shop B's
// product under :id = A must be refused, not silently allowed to touch (or delete) a stranger's
// row. See CLAUDE.md → Backend, Global Constraint 2.
import { describe, it, expect } from 'vitest'
import { app } from '../../src/app.js'
import { makeUser, seedMerchant, seedProduct, serviceClient, resetMerchant } from '../rls/helpers.js'

async function tokenOf(client: Awaited<ReturnType<typeof makeUser>>) {
  const { data } = await client.auth.getSession()
  return { token: data.session!.access_token, userId: data.session!.user.id }
}

function put(path: string, body: unknown, token?: string) {
  return app.request(path, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

function del(path: string, token?: string) {
  return app.request(path, {
    method: 'DELETE',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
}

type ProductRow = { id: string; merchant_id: string; name: string; price: number }

describe('PUT /api/merchants/:id/products/:productId', () => {
  it('upserts a product for the owner, forcing merchant_id from the route', async () => {
    await resetMerchant('prod-owner-shop')
    const owner = await makeUser('prod-owner@example.com', 'password123')
    const { token, userId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'prod-owner-shop', owner_id: userId })
    const productId = crypto.randomUUID()

    const res = await put(`/api/merchants/${id}/products/${productId}`, {
      name: 'Brown Butter Cookie',
      price: 12.5,
      unit: 'pcs',
      active: true,
    }, token)

    expect(res.status).toBe(200)
    const row = (await res.json()) as ProductRow
    expect(row.id).toBe(productId)
    expect(row.merchant_id).toBe(id)
    expect(row.name).toBe('Brown Butter Cookie')

    await serviceClient().from('products').delete().eq('id', productId)
    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('ignores a client-supplied merchant_id (forced from :id)', async () => {
    await resetMerchant('prod-evil-shop')
    const owner = await makeUser('prod-evil-owner@example.com', 'password123')
    const { token, userId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'prod-evil-shop', owner_id: userId })
    const productId = crypto.randomUUID()

    const res = await put(`/api/merchants/${id}/products/${productId}`, {
      name: 'Sneaky Item',
      price: 1,
      merchant_id: '00000000-0000-0000-0000-000000000000',
    }, token)

    expect(res.status).toBe(200)
    const row = (await res.json()) as ProductRow
    expect(row.merchant_id).toBe(id)

    await serviceClient().from('products').delete().eq('id', productId)
    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('403 for a non-owner', async () => {
    await resetMerchant('prod-a-shop')
    const owner = await makeUser('prod-a-owner@example.com', 'password123')
    const { userId: ownerId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'prod-a-shop', owner_id: ownerId })

    const other = await makeUser('prod-a-other@example.com', 'password123')
    const { token: otherToken } = await tokenOf(other)

    const res = await put(`/api/merchants/${id}/products/${crypto.randomUUID()}`, { name: 'x', price: 1 }, otherToken)
    expect(res.status).toBe(403)

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('401 without a token', async () => {
    await resetMerchant('prod-anon-shop')
    const owner = await makeUser('prod-anon-owner@example.com', 'password123')
    const { userId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'prod-anon-shop', owner_id: userId })

    const res = await put(`/api/merchants/${id}/products/${crypto.randomUUID()}`, { name: 'x', price: 1 })
    expect(res.status).toBe(401)

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  // Load-bearing: .upsert() conflict-resolves on the primary key (id), so without a tenancy
  // check an owner of shop A could nest shop B's productId under :id = A and have it UPDATEd
  // in place — including merchant_id reassigned to A, a cross-tenant takeover. Product ids are
  // enumerable via the public GET /api/merchants/:id/products. See CLAUDE.md → Global Constraint 2.
  it('404s and leaves the row intact when the product belongs to a different shop', async () => {
    await resetMerchant('prod-put-tenant-a')
    await resetMerchant('prod-put-tenant-b')
    const ownerA = await makeUser('prod-put-tenant-a-owner@example.com', 'password123')
    const { token: tokenA, userId: ownerAId } = await tokenOf(ownerA)
    const shopA = await seedMerchant({ slug: 'prod-put-tenant-a', owner_id: ownerAId })

    const ownerB = await makeUser('prod-put-tenant-b-owner@example.com', 'password123')
    const { userId: ownerBId } = await tokenOf(ownerB)
    const shopB = await seedMerchant({ slug: 'prod-put-tenant-b', owner_id: ownerBId })
    const productB = await seedProduct({ merchant_id: shopB, name: 'Shop B Cookie', price: 7 })

    const res = await put(`/api/merchants/${shopA}/products/${productB}`, { name: 'Hijacked', price: 999 }, tokenA)
    expect(res.status).toBe(404)

    const { data } = await serviceClient()
      .from('products').select('id, merchant_id, name, price').eq('id', productB).single()
    expect(data!.merchant_id).toBe(shopB)
    expect(data!.name).toBe('Shop B Cookie')
    expect(data!.price).toBe(7)

    await serviceClient().from('products').delete().eq('id', productB)
    await serviceClient().from('merchants').delete().eq('id', shopA)
    await serviceClient().from('merchants').delete().eq('id', shopB)
  })
})

describe('DELETE /api/merchants/:id/products/:productId', () => {
  it('deletes the owner’s own product', async () => {
    await resetMerchant('prod-del-shop')
    const owner = await makeUser('prod-del-owner@example.com', 'password123')
    const { token, userId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'prod-del-shop', owner_id: userId })
    const productId = await seedProduct({ merchant_id: id, name: 'Doomed Cookie', price: 5 })

    const res = await del(`/api/merchants/${id}/products/${productId}`, token)
    expect(res.status).toBe(200)

    const { data } = await serviceClient().from('products').select('id').eq('id', productId).maybeSingle()
    expect(data).toBeNull()

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  // Load-bearing: an owner of shop A cannot delete shop B's product by nesting it under
  // :id = A. requireMerchantOwns only proves ownership of :id; the handler must separately
  // verify the product's own merchant_id before deleting it.
  it('404s and leaves the row intact when the product belongs to a different shop', async () => {
    await resetMerchant('prod-tenant-a')
    await resetMerchant('prod-tenant-b')
    const ownerA = await makeUser('prod-tenant-a-owner@example.com', 'password123')
    const { token: tokenA, userId: ownerAId } = await tokenOf(ownerA)
    const shopA = await seedMerchant({ slug: 'prod-tenant-a', owner_id: ownerAId })

    const ownerB = await makeUser('prod-tenant-b-owner@example.com', 'password123')
    const { userId: ownerBId } = await tokenOf(ownerB)
    const shopB = await seedMerchant({ slug: 'prod-tenant-b', owner_id: ownerBId })
    const productB = await seedProduct({ merchant_id: shopB, name: 'Shop B Cookie', price: 7 })

    const res = await del(`/api/merchants/${shopA}/products/${productB}`, tokenA)
    expect(res.status).toBe(404)

    const { data } = await serviceClient().from('products').select('id, merchant_id').eq('id', productB).single()
    expect(data!.merchant_id).toBe(shopB)

    await serviceClient().from('products').delete().eq('id', productB)
    await serviceClient().from('merchants').delete().eq('id', shopA)
    await serviceClient().from('merchants').delete().eq('id', shopB)
  })

  it('403 for a non-owner', async () => {
    await resetMerchant('prod-del-a-shop')
    const owner = await makeUser('prod-del-a-owner@example.com', 'password123')
    const { userId: ownerId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'prod-del-a-shop', owner_id: ownerId })
    const productId = await seedProduct({ merchant_id: id, name: 'Guarded Cookie', price: 3 })

    const other = await makeUser('prod-del-a-other@example.com', 'password123')
    const { token: otherToken } = await tokenOf(other)

    const res = await del(`/api/merchants/${id}/products/${productId}`, otherToken)
    expect(res.status).toBe(403)

    await serviceClient().from('products').delete().eq('id', productId)
    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('401 without a token', async () => {
    await resetMerchant('prod-del-anon-shop')
    const owner = await makeUser('prod-del-anon-owner@example.com', 'password123')
    const { userId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'prod-del-anon-shop', owner_id: userId })
    const productId = await seedProduct({ merchant_id: id, name: 'Anon Cookie', price: 3 })

    const res = await del(`/api/merchants/${id}/products/${productId}`)
    expect(res.status).toBe(401)

    await serviceClient().from('products').delete().eq('id', productId)
    await serviceClient().from('merchants').delete().eq('id', id)
  })
})
