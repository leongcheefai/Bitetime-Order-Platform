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

  it('lists feedback newest-first to a superadmin — the freshest post lands first, with the shop attached', async () => {
    // Every prior row in `mine` shares this same shop, so a naive "is mine[0] my shop"
    // check can't fail no matter what order the rows come back in. Post one more row
    // right here and assert it — the one we KNOW is newest — is first; that only holds
    // if listFeedback's `.order('created_at', { ascending: false })` is doing its job.
    const probe = await post(`/api/merchants/${ownShopId}/feedback`,
      { category: 'other', message: 'freshest feedback for the ordering probe' }, ownerToken)
    const probeRow = (await probe.json()) as FeedbackRow

    const res = await get('/api/admin/feedback', superToken)
    expect(res.status).toBe(200)
    const rows = (await res.json()) as Array<FeedbackRow & { shop_slug: string | null }>
    const mine = rows.filter(r => r.merchant_id === ownShopId)
    expect(mine.length).toBeGreaterThanOrEqual(3)
    expect(mine[0]!.id).toBe(probeRow.id)
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

  // feedbackWindow (app.ts) is a module-level singleton shared by every test in this
  // process, and it cannot be reset from outside. Using feedback-owner / feedback-own-shop
  // here would burn the quota the earlier tests still rely on, so this test gets its own
  // pair of users and shops, distinct from every fixture above.
  //
  // The test proves the limit trips at 20 per hour and that the counter is not global
  // (a different user is unaffected). It does not distinguish per-user from per-merchant
  // keying: merchants_owner_id_key, a unique partial index enforcing one shop per owner
  // (migration 20260715120100_referral_reward_lookup.sql), means the two are behaviorally
  // identical for every reachable request state. If a multi-shop-per-owner model lands,
  // this distinction becomes testable and the test should be extended then.
  // This issues 22 requests; kept to this one test.
  it('rate-limits feedback submissions per user, not globally', async () => {
    await resetMerchant('feedback-limit-shop')
    await resetMerchant('feedback-limit-second-shop')

    const limited = await makeUser('feedback-limit-owner@example.com', 'password123')
    const limitedIds = await tokenOf(limited)
    const limitedShopId = await seedMerchant({ slug: 'feedback-limit-shop', owner_id: limitedIds.userId })

    const other = await makeUser('feedback-limit-second@example.com', 'password123')
    const otherIds = await tokenOf(other)
    const otherShopId = await seedMerchant({ slug: 'feedback-limit-second-shop', owner_id: otherIds.userId })

    // Exhaust the limited user's budget: the window allows 20 per hour.
    for (let i = 0; i < 20; i++) {
      const res = await post(`/api/merchants/${limitedShopId}/feedback`,
        { category: 'other', message: `submission ${i}` }, limitedIds.token)
      expect(res.status).toBe(201)
    }

    const blocked = await post(`/api/merchants/${limitedShopId}/feedback`,
      { category: 'other', message: 'one too many' }, limitedIds.token)
    expect(blocked.status).toBe(429)

    // A different user, submitting to a shop they own, is unaffected — proving the
    // limiter is keyed per user rather than sharing one global (or per-merchant) counter.
    const stillAllowed = await post(`/api/merchants/${otherShopId}/feedback`,
      { category: 'other', message: 'a different user, a fresh budget' }, otherIds.token)
    expect(stillAllowed.status).toBe(201)
  })
})
