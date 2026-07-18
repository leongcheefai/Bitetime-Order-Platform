// tests/api/writes-profile.test.ts
// PUT /api/me/profile — global profile (merchant_id IS NULL) upsert. The load-bearing
// assertion is that the handler forces user_id/merchant_id server-side and allowlists the
// rest: the write goes through `admin` (service_role), which BYPASSES guard_profile_privileges,
// so if the handler ever spread a raw client body into .insert()/.update() a caller could grant
// themselves app_role='superadmin' or attach their profile to someone else's merchant_id. See
// CLAUDE.md → Backend, Global Constraint 1.
import { describe, it, expect } from 'vitest'
import { app } from '../../src/app.js'
import { makeUser, serviceClient } from '../rls/helpers.js'

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

async function cleanupProfile(userId: string) {
  await serviceClient().from('profiles').delete().eq('user_id', userId).is('merchant_id', null)
}

describe('PUT /api/me/profile', () => {
  it('creates the caller global profile on first call, updates the SAME row on the second', async () => {
    const client = await makeUser('prof@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    await cleanupProfile(userId)

    let res = await put('/api/me/profile', { name: 'Ada' }, token)
    expect(res.status).toBe(200)

    res = await put('/api/me/profile', { name: 'Ada Lovelace' }, token)
    expect(res.status).toBe(200)

    const { data: rows } = await serviceClient()
      .from('profiles').select('*').eq('user_id', userId).is('merchant_id', null)
    expect(rows).toHaveLength(1) // upsert, not a second insert
    expect(rows![0].name).toBe('Ada Lovelace')

    await cleanupProfile(userId)
  })

  it('refuses to set app_role or merchant_id from the body (privilege guard)', async () => {
    const client = await makeUser('prof-evil@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    await cleanupProfile(userId)

    const res = await put('/api/me/profile', {
      name: 'x',
      app_role: 'superadmin',
      merchant_id: '00000000-0000-0000-0000-000000000000',
    }, token)
    expect(res.status).toBe(200)

    // Load-bearing: read back with the service client, NOT the response body. The write goes
    // through `admin` (service_role), which bypasses guard_profile_privileges, so
    // pickProfileFields + forcing user_id/merchant_id is the ONLY thing standing between this
    // body and self-granted superadmin.
    const { data } = await serviceClient()
      .from('profiles').select('app_role, merchant_id').eq('user_id', userId).is('merchant_id', null).single()
    expect(data!.app_role).not.toBe('superadmin')
    expect(data!.merchant_id).toBeNull()

    await cleanupProfile(userId)
  })

  it('401 without a token', async () => {
    const res = await put('/api/me/profile', { name: 'x' })
    expect(res.status).toBe(401)
  })
})
