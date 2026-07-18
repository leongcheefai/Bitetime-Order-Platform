// tests/api/writes-merchants.test.ts
// POST /api/merchants — create-shop endpoint. The load-bearing assertion is that the
// handler forces status/owner_id server-side: the insert goes through `admin`
// (service_role), which BYPASSES guard_merchant_status, so if the handler ever spread a
// raw client body into .insert() a caller could self-activate their own shop or plant it
// under someone else's owner_id. See CLAUDE.md → Backend, Global Constraint 1.
import { describe, it, expect } from 'vitest'
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
