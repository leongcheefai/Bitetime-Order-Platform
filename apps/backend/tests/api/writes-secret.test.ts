// tests/api/writes-secret.test.ts
// PUT /api/merchants/:id/secret — merchant secret upsert. The load-bearing assertions are:
// (1) the write round-trips through the Phase A GET, (2) a second upsert UPDATES the existing
// row rather than duplicating it (merchant_secrets.merchant_id is the primary key / conflict
// target — see 20260627120150_secure_merchant_secrets.sql), and (3) tenancy is enforced by
// requireMerchantOwns exactly as it is on every other owner-scoped write. See CLAUDE.md →
// Backend, Global Constraint 1.
import { describe, it, expect } from 'vitest'
import { app } from '../../src/app.js'
import { makeUser, seedMerchant, serviceClient, resetMerchant } from '../rls/helpers.js'

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

function get(path: string, token?: string) {
  return app.request(path, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
}

type SecretRow = { tg_token: string | null; tg_chat_id: string | null }

describe('PUT /api/merchants/:id/secret', () => {
  it('upserts a secret for the owner and round-trips it via GET', async () => {
    await resetMerchant('secret-owner-shop')
    const client = await makeUser('secret-owner@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    const id = await seedMerchant({ slug: 'secret-owner-shop', owner_id: userId })

    const res = await put(`/api/merchants/${id}/secret`, { tg_token: 'tok-123', tg_chat_id: 'chat-456' }, token)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    const getRes = await get(`/api/merchants/${id}/secret`, token)
    expect(getRes.status).toBe(200)
    const row = (await getRes.json()) as SecretRow
    expect(row.tg_token).toBe('tok-123')
    expect(row.tg_chat_id).toBe('chat-456')

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('a second upsert UPDATEs the existing row rather than duplicating it', async () => {
    await resetMerchant('secret-update-shop')
    const client = await makeUser('secret-update@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    const id = await seedMerchant({ slug: 'secret-update-shop', owner_id: userId })

    const first = await put(`/api/merchants/${id}/secret`, { tg_token: 'first-tok', tg_chat_id: 'first-chat' }, token)
    expect(first.status).toBe(200)

    const second = await put(`/api/merchants/${id}/secret`, { tg_token: 'second-tok', tg_chat_id: 'second-chat' }, token)
    expect(second.status).toBe(200)

    const { data: rows, error } = await serviceClient()
      .from('merchant_secrets').select('tg_token, tg_chat_id').eq('merchant_id', id)
    expect(error).toBeNull()
    expect(rows).toHaveLength(1)
    expect(rows![0].tg_token).toBe('second-tok')
    expect(rows![0].tg_chat_id).toBe('second-chat')

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('403 for a non-owner', async () => {
    await resetMerchant('secret-a-shop')
    const owner = await makeUser('secret-a@example.com', 'password123')
    const { userId: ownerId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'secret-a-shop', owner_id: ownerId })

    const other = await makeUser('secret-b@example.com', 'password123')
    const { token: otherToken } = await tokenOf(other)

    const res = await put(`/api/merchants/${id}/secret`, { tg_token: 'x', tg_chat_id: 'y' }, otherToken)
    expect(res.status).toBe(403)

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('401 without a token', async () => {
    await resetMerchant('secret-anon-shop')
    const client = await makeUser('secret-anon@example.com', 'password123')
    const { userId } = await tokenOf(client)
    const id = await seedMerchant({ slug: 'secret-anon-shop', owner_id: userId })

    const res = await put(`/api/merchants/${id}/secret`, { tg_token: 'x', tg_chat_id: 'y' })
    expect(res.status).toBe(401)

    await serviceClient().from('merchants').delete().eq('id', id)
  })
})
