// tests/api/feedback.test.ts
// Merchant platform feedback (#89), driven in-process.
//
// The load-bearing assertions are the two the service-role client makes possible to get
// wrong: a merchant must not be able to file feedback against a shop they do not own, and
// a body carrying merchant_id / user_id / status must not be believed. admin is RLS-exempt,
// so requireMerchantOwns and the field-by-field build in validateFeedback are the ONLY
// things standing between a merchant and another shop's record. See CLAUDE.md → Backend.
import { describe, it, expect, beforeAll } from 'vitest'
import { app } from '../../src/app.js'
import { makeUser, seedMerchant, serviceClient, resetMerchant } from '../rls/helpers.js'

async function tokenOf(client: Awaited<ReturnType<typeof makeUser>>) {
  const { data } = await client.auth.getSession()
  return { token: data.session!.access_token, userId: data.session!.user.id }
}

function post(path: string, body: unknown, token?: string) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
}

function get(path: string, token?: string) {
  return app.request(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
}

function patch(path: string, body: unknown, token?: string) {
  return app.request(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
}

type FeedbackRow = {
  id: string; merchant_id: string; user_id: string
  category: string; message: string; status: string; resolved_at: string | null
}

describe('merchant feedback', () => {
  let ownerToken: string
  let ownerId: string
  let ownShopId: string
  let strangerShopId: string
  let superToken: string

  beforeAll(async () => {
    await resetMerchant('feedback-own-shop')
    await resetMerchant('feedback-stranger-shop')

    const owner = await makeUser('feedback-owner@example.com', 'password123')
    const owned = await tokenOf(owner)
    ownerToken = owned.token
    ownerId = owned.userId
    ownShopId = await seedMerchant({ slug: 'feedback-own-shop', owner_id: ownerId })

    const stranger = await makeUser('feedback-stranger@example.com', 'password123')
    const strangerIds = await tokenOf(stranger)
    strangerShopId = await seedMerchant({ slug: 'feedback-stranger-shop', owner_id: strangerIds.userId })

    const superClient = await makeUser('feedback-super@example.com', 'password123')
    const superIds = await tokenOf(superClient)
    const svc = serviceClient()
    await svc.from('profiles').delete().eq('user_id', superIds.userId)
    await svc.from('profiles').insert({ user_id: superIds.userId, name: 'Super', app_role: 'superadmin' })
    superToken = superIds.token
  })

  it('stores feedback for the shop the caller owns', async () => {
    const res = await post(`/api/merchants/${ownShopId}/feedback`, {
      category: 'bug', message: '  the orders tab is blank on mobile  ',
    }, ownerToken)

    expect(res.status).toBe(201)
    const row = (await res.json()) as FeedbackRow
    expect(row.merchant_id).toBe(ownShopId)
    expect(row.user_id).toBe(ownerId)
    expect(row.category).toBe('bug')
    expect(row.message).toBe('the orders tab is blank on mobile')
    expect(row.status).toBe('open')
    expect(row.resolved_at).toBeNull()
  })

  it('refuses feedback filed against a shop the caller does not own', async () => {
    const res = await post(`/api/merchants/${strangerShopId}/feedback`, {
      category: 'other', message: 'not my shop',
    }, ownerToken)
    expect(res.status).toBe(403)
  })

  it('rejects an anonymous submission with 401', async () => {
    const res = await post(`/api/merchants/${ownShopId}/feedback`, { category: 'other', message: 'hi' })
    expect(res.status).toBe(401)
  })

  it('ignores merchant_id, user_id and status supplied in the body', async () => {
    const res = await post(`/api/merchants/${ownShopId}/feedback`, {
      category: 'billing', message: 'charged twice',
      merchant_id: strangerShopId, user_id: '00000000-0000-0000-0000-000000000000',
      status: 'resolved',
    }, ownerToken)

    expect(res.status).toBe(201)
    const row = (await res.json()) as FeedbackRow
    expect(row.merchant_id).toBe(ownShopId)
    expect(row.user_id).toBe(ownerId)
    expect(row.status).toBe('open')
  })

  it('400s on an unknown category and on an empty message', async () => {
    expect((await post(`/api/merchants/${ownShopId}/feedback`,
      { category: 'complaint', message: 'hello' }, ownerToken)).status).toBe(400)
    expect((await post(`/api/merchants/${ownShopId}/feedback`,
      { category: 'other', message: '   ' }, ownerToken)).status).toBe(400)
  })

  it('lists feedback newest-first to a superadmin, with the shop attached', async () => {
    const res = await get('/api/admin/feedback', superToken)
    expect(res.status).toBe(200)
    const rows = (await res.json()) as Array<FeedbackRow & { shop_slug: string | null }>
    const mine = rows.filter(r => r.merchant_id === ownShopId)
    expect(mine.length).toBeGreaterThanOrEqual(2)
    expect(mine[0]!.shop_slug).toBe('feedback-own-shop')
  })

  it('refuses the admin list to a merchant and to an anonymous caller', async () => {
    expect((await get('/api/admin/feedback', ownerToken)).status).toBe(403)
    expect((await get('/api/admin/feedback')).status).toBe(401)
  })

  it('resolves and reopens, stamping and clearing resolved_at', async () => {
    const created = await post(`/api/merchants/${ownShopId}/feedback`,
      { category: 'feature', message: 'export orders to csv' }, ownerToken)
    const { id } = (await created.json()) as FeedbackRow

    const resolved = await patch(`/api/admin/feedback/${id}`, { status: 'resolved' }, superToken)
    expect(resolved.status).toBe(200)
    const resolvedRow = (await resolved.json()) as FeedbackRow
    expect(resolvedRow.status).toBe('resolved')
    expect(resolvedRow.resolved_at).not.toBeNull()

    const reopened = await patch(`/api/admin/feedback/${id}`, { status: 'open' }, superToken)
    const reopenedRow = (await reopened.json()) as FeedbackRow
    expect(reopenedRow.status).toBe('open')
    expect(reopenedRow.resolved_at).toBeNull()
  })

  it('filters the list to open only', async () => {
    const res = await get('/api/admin/feedback?status=open', superToken)
    expect(res.status).toBe(200)
    const rows = (await res.json()) as FeedbackRow[]
    expect(rows.every(r => r.status === 'open')).toBe(true)
  })

  it('400s on an unknown status, both as a filter and as an update', async () => {
    expect((await get('/api/admin/feedback?status=closed', superToken)).status).toBe(400)
    const created = await post(`/api/merchants/${ownShopId}/feedback`,
      { category: 'other', message: 'status check' }, ownerToken)
    const { id } = (await created.json()) as FeedbackRow
    expect((await patch(`/api/admin/feedback/${id}`, { status: 'closed' }, superToken)).status).toBe(400)
  })

  it('404s when resolving feedback that does not exist', async () => {
    const res = await patch('/api/admin/feedback/00000000-0000-0000-0000-000000000000',
      { status: 'resolved' }, superToken)
    expect(res.status).toBe(404)
  })

  it('refuses a status change from a merchant', async () => {
    const created = await post(`/api/merchants/${ownShopId}/feedback`,
      { category: 'other', message: 'merchant cannot resolve this' }, ownerToken)
    const { id } = (await created.json()) as FeedbackRow
    expect((await patch(`/api/admin/feedback/${id}`, { status: 'resolved' }, ownerToken)).status).toBe(403)
  })
})
