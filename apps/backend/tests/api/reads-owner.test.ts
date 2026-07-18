// tests/api/reads-owner.test.ts
// Owner-scoped reads. The load-bearing assertion is TENANT ISOLATION: merchant A, with a
// perfectly valid token, gets 403 on merchant B's orders/vouchers/billing/secret. admin is
// RLS-exempt, so requireMerchantOwns is the only thing enforcing this.
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

describe('owner reads', () => {
  let aToken: string, bToken: string, aId: string

  beforeAll(async () => {
    const a = await makeUser('owner-a@example.com', 'password123')
    const b = await makeUser('owner-b@example.com', 'password123')
    const { data: as } = await a.auth.getSession()
    const { data: bs } = await b.auth.getSession()
    aId = await seedMerchant({ slug: 'owner-a-shop', owner_id: as.session!.user.id })
    await seedMerchant({ slug: 'owner-b-shop', owner_id: bs.session!.user.id })
    aToken = await tokenOf(a)
    bToken = await tokenOf(b)
    // Give shop A one voucher so its list is non-empty.
    await serviceClient().from('vouchers').insert({ merchant_id: aId, code: 'OWNERTEST', kind: 'flat', amount: 5 })
  })

  it('lets the owner read their orders, count, vouchers, billing, secret', async () => {
    for (const path of [
      `/api/merchants/${aId}/orders`,
      `/api/merchants/${aId}/orders/count`,
      `/api/merchants/${aId}/vouchers`,
      `/api/merchants/${aId}/billing`,
      `/api/merchants/${aId}/secret`,
    ]) {
      expect((await get(path, aToken)).status).toBe(200)
    }
  })

  it('returns the count as { count }', async () => {
    const res = await get(`/api/merchants/${aId}/orders/count`, aToken)
    expect(await res.json()).toEqual({ count: 0 })
  })

  it("forbids a different merchant from reading shop A's rows", async () => {
    for (const path of [
      `/api/merchants/${aId}/orders`,
      `/api/merchants/${aId}/vouchers`,
      `/api/merchants/${aId}/billing`,
      `/api/merchants/${aId}/secret`,
    ]) {
      expect((await get(path, bToken)).status).toBe(403)
    }
  })

  it('rejects an anonymous caller with 401', async () => {
    expect((await get(`/api/merchants/${aId}/orders`)).status).toBe(401)
  })
})
