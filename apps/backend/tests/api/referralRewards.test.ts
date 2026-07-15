// tests/api/referralRewards.test.ts
// GET /api/referrals/rewards — the free months a member earned. Same security property as
// /shops: the reward rows are scoped to the caller's OWN merchant, resolved from the verified
// JWT, on the RLS-exempt sql connection. The test that matters is that a stranger sees none
// of another member's rewards, and no request input can widen the scope.
//
// Runs against a real local Supabase. Never mocked — see vitest.db.config.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { app } from '../../src/app.js'
import { listEarnedRewards, type EarnedReward } from '../../src/referrals.js'
import { makeUser, seedMerchant, serviceClient } from '../rls/helpers.js'

const SLUGS = ['rew-referrer-shop', 'rew-referred-a', 'rew-referred-b']

async function tokenFor(client: Awaited<ReturnType<typeof makeUser>>) {
  const { data } = await client.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('signed-in client returned no access token')
  return token
}

function get(token?: string) {
  return app.request('/api/referrals/rewards', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
}

const rewardsIn = (res: Response) => res.json() as Promise<EarnedReward[]>

describe('GET /api/referrals/rewards', () => {
  let referrerToken: string
  let strangerToken: string
  let referrerUserId: string

  beforeAll(async () => {
    const referrer = await makeUser('rew-referrer@example.com', 'password123')
    const stranger = await makeUser('rew-stranger@example.com', 'password123')
    const invitedA = await makeUser('rew-invited-a@example.com', 'password123')
    const invitedB = await makeUser('rew-invited-b@example.com', 'password123')

    referrerUserId = (await referrer.auth.getUser()).data.user!.id
    referrerToken = await tokenFor(referrer)
    strangerToken = await tokenFor(stranger)

    const owner = async (c: typeof invitedA) => (await c.auth.getUser()).data.user!.id

    // The referrer owns one shop; two other shops (owned by the invited members) each earned
    // the referrer a reward.
    const referrerShop = await seedMerchant({ slug: 'rew-referrer-shop', owner_id: referrerUserId, name: 'Referrer Shop', status: 'active' })
    const referredA = await seedMerchant({ slug: 'rew-referred-a', owner_id: await owner(invitedA), name: 'Referred A', status: 'active' })
    const referredB = await seedMerchant({ slug: 'rew-referred-b', owner_id: await owner(invitedB), name: 'Referred B', status: 'active' })

    const svc = serviceClient()
    await svc.from('referral_rewards').insert([
      { referred_merchant_id: referredA, referrer_merchant_id: referrerShop, amount: 2900, currency: 'usd', stripe_customer_id: 'cus_a', stripe_balance_txn_id: 'cbtxn_a', created_at: '2026-06-01T00:00:00Z' },
      { referred_merchant_id: referredB, referrer_merchant_id: referrerShop, amount: 2500, currency: 'usd', stripe_customer_id: 'cus_b', stripe_balance_txn_id: 'cbtxn_b', created_at: '2026-07-01T00:00:00Z' },
    ])
  })

  afterAll(async () => {
    await serviceClient().from('merchants').delete().in('slug', SLUGS)
  })

  it('lists the rewards the caller earned, newest first', async () => {
    const res = await get(referrerToken)
    expect(res.status).toBe(200)

    const rewards = await rewardsIn(res)
    expect(rewards.map(r => r.referred_shop_name)).toEqual(['Referred B', 'Referred A'])
    expect(rewards[0]).toEqual({
      referred_shop_name: 'Referred B',
      amount: 2500,
      currency: 'usd',
      created_at: '2026-07-01T00:00:00.000Z',
    })
  })

  it('hands back created_at as a real string, not the driver’s Date', async () => {
    const [first] = await listEarnedRewards(referrerUserId)
    expect(typeof first.created_at).toBe('string')
  })

  it('shows a stranger none of the referrer’s rewards', async () => {
    const res = await get(strangerToken)
    expect(res.status).toBe(200)
    expect(await rewardsIn(res)).toEqual([])
  })

  it('rejects an anonymous caller', async () => {
    expect((await get()).status).toBe(401)
  })
})
