// tests/api/reads-admin.test.ts
// Superadmin read endpoints, driven in-process. Proves the requireUser + requireSuperadmin
// gate: no token → 401, ordinary user → 403, superadmin → 200 with rows. admin uses the
// service-role client, so these gates are the ONLY thing standing between a merchant and
// every shop's billing — load-bearing, not decoration.
import { describe, it, expect, beforeAll } from 'vitest'
import { app } from '../../src/app.js'
import { makeUser, seedMerchant, serviceClient } from '../rls/helpers.js'

async function tokenOf(client: Awaited<ReturnType<typeof makeUser>>) {
  const { data } = await client.auth.getSession()
  return data.session!.access_token
}

function get(path: string, token?: string) {
  return app.request(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
}

describe('superadmin reads', () => {
  let superToken: string
  let plainToken: string

  beforeAll(async () => {
    const superClient = await makeUser('super-reads@example.com', 'password123')
    const { data: sess } = await superClient.auth.getSession()
    const superUserId = sess.session!.user.id
    // Grant superadmin via a global profile row.
    const svc = serviceClient()
    await svc.from('profiles').delete().eq('user_id', superUserId)
    await svc.from('profiles').insert({ user_id: superUserId, name: 'Super', app_role: 'superadmin' })
    superToken = await tokenOf(superClient)

    const plainClient = await makeUser('plain-reads@example.com', 'password123')
    const { data: psess } = await plainClient.auth.getSession()
    await seedMerchant({ slug: 'admin-read-shop', owner_id: psess.session!.user.id })
    plainToken = await tokenOf(plainClient)
  })

  it('rejects an anonymous caller with 401', async () => {
    expect((await get('/api/merchants')).status).toBe(401)
    expect((await get('/api/billing')).status).toBe(401)
  })

  it('rejects a non-superadmin with 403', async () => {
    expect((await get('/api/merchants', plainToken)).status).toBe(403)
    expect((await get('/api/billing', plainToken)).status).toBe(403)
  })

  it('returns all merchants to a superadmin', async () => {
    const res = await get('/api/merchants', superToken)
    expect(res.status).toBe(200)
    const rows = (await res.json()) as Array<{ slug: string }>
    expect(rows.some(m => m.slug === 'admin-read-shop')).toBe(true)
  })

  it('returns billing rows to a superadmin', async () => {
    const res = await get('/api/billing', superToken)
    expect(res.status).toBe(200)
    expect(Array.isArray(await res.json())).toBe(true)
  })

  it('gates set-merchant-status: 401 anon, 403 non-super', async () => {
    const anon = await app.request('/api/admin/set-merchant-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merchantId: 'x', status: 'active' }),
    })
    expect(anon.status).toBe(401)

    const plain = await app.request('/api/admin/set-merchant-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plainToken}` },
      body: JSON.stringify({ merchantId: 'x', status: 'active' }),
    })
    expect(plain.status).toBe(403)
  })
})
