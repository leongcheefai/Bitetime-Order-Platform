// tests/api/reads-user.test.ts
// User-scoped reads. The load-bearing assertion is the uid filter on my-orders: the merchant's
// own select policy would hand a shop owner EVERY customer's order, so "your orders" only means
// yours because the endpoint filters by the caller's uid — proven here with two customers.
import { describe, it, expect, beforeAll } from 'vitest'
import { app } from '../../src/app.js'
import { makeUser, seedMerchant, serviceClient } from '../rls/helpers.js'

async function tokenOf(client: Awaited<ReturnType<typeof makeUser>>) {
  const { data } = await client.auth.getSession()
  return data.session!.access_token
}
function get(path: string, token?: string) {
  return app.request(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
}

describe('user reads', () => {
  let custAToken: string, custBToken: string, custAId: string, shopId: string

  beforeAll(async () => {
    const owner = await makeUser('user-owner@example.com', 'password123')
    const { data: os } = await owner.auth.getSession()
    shopId = await seedMerchant({ slug: 'user-shop', owner_id: os.session!.user.id, order_prefix: 'US' })

    const a = await makeUser('cust-a@example.com', 'password123')
    const b = await makeUser('cust-b@example.com', 'password123')
    const { data: as } = await a.auth.getSession()
    const { data: bs } = await b.auth.getSession()
    custAId = as.session!.user.id
    custAToken = await tokenOf(a)
    custBToken = await tokenOf(b)

    // Two orders at the shop: one for A, one for B.
    const svc = serviceClient()
    await svc.from('orders').insert([
      { merchant_id: shopId, user_id: custAId, order_number: 'US-260718-0050', status: 'new', customer_name: 'A' },
      { merchant_id: shopId, user_id: bs.session!.user.id, order_number: 'US-260718-0051', status: 'new', customer_name: 'B' },
    ])
  })

  it('rejects an anonymous caller with 401 on me/profile', async () => {
    expect((await get('/api/me/profile')).status).toBe(401)
  })

  it('returns only the caller\'s own orders at the shop', async () => {
    const res = await get(`/api/merchants/${shopId}/my-orders`, custAToken)
    expect(res.status).toBe(200)
    const rows = (await res.json()) as Array<{ user_id: string }>
    expect(rows.length).toBe(1)
    expect(rows[0].user_id).toBe(custAId)
  })

  it('returns a different set for a different customer', async () => {
    const res = await get(`/api/merchants/${shopId}/my-orders`, custBToken)
    const rows = (await res.json()) as Array<{ customer_name: string }>
    expect(rows.length).toBe(1)
    expect(rows[0].customer_name).toBe('B')
  })

  it('returns the owner\'s merchant from me/merchant', async () => {
    const owner = await makeUser('user-owner2@example.com', 'password123')
    const { data: os } = await owner.auth.getSession()
    await seedMerchant({ slug: 'user-shop2', owner_id: os.session!.user.id })
    const res = await get('/api/me/merchant', await tokenOf(owner))
    expect(res.status).toBe(200)
    expect((await res.json() as { slug: string }).slug).toBe('user-shop2')
  })
})
