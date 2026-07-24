// tests/api/billing-actions.test.ts
// POST /api/billing/{downgrade,cancel,resume} — the guards in front of them.
//
// Scope is deliberate: everything PAST the guard calls Stripe, and these suites are
// network-free (see the note at the head of webhook-plan.test.ts). What is asserted here is the
// half that can be — who is allowed to ask, and what happens to a shop that has nothing to
// change. That half is where the damage is: a missing auth check on these routes would let any
// signed-in user cancel a stranger's subscription and close their shop.
//
// The scheduling arithmetic itself is covered without a network by tests/unit/subscriptionSchedule.
import { describe, it, expect } from 'vitest'
import { app } from '../../src/app.js'
import { makeUser, seedMerchant, serviceClient, resetMerchant } from '../rls/helpers.js'

const ROUTES = ['downgrade', 'cancel', 'resume'] as const

function post(route: string, token?: string) {
  return app.request(`/api/billing/${route}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
}

async function sessionOf(client: Awaited<ReturnType<typeof makeUser>>) {
  const { data } = await client.auth.getSession()
  return { token: data.session!.access_token, userId: data.session!.user.id }
}

describe('billing wind-down routes', () => {
  // These change what a merchant is billed and can suspend a shop. An unauthenticated caller
  // must not reach the Stripe call at all.
  it('refuses an unauthenticated caller', async () => {
    for (const route of ROUTES) {
      expect((await post(route)).status).toBe(401)
    }
  })

  it('refuses a bad token', async () => {
    for (const route of ROUTES) {
      expect((await post(route, 'not-a-jwt')).status).toBe(401)
    }
  })

  // The subscription is resolved from the caller's OWN merchant, looked up by the JWT's user id —
  // there is no id in the path or body to point somewhere else. A signed-in user who owns no
  // shop therefore has nothing to act on.
  it('refuses a signed-in user who owns no shop', async () => {
    const user = await makeUser('billing-no-shop@example.com', 'password123')
    const { token } = await sessionOf(user)
    for (const route of ROUTES) {
      expect((await post(route, token)).status).toBe(404)
    }
  })

  // 409 rather than 404: the shop is fine, the request just does not apply to it. The
  // Subscription tab hides these buttons in this state, so reaching here means a long-open tab —
  // and the frontend turns this code into "reload the page", not "something broke".
  it('answers 409 no_live_subscription for a shop with no billing row', async () => {
    await resetMerchant('billing-actions-shop')
    const owner = await makeUser('billing-actions@example.com', 'password123')
    const { token, userId } = await sessionOf(owner)
    const id = await seedMerchant({ slug: 'billing-actions-shop', owner_id: userId, plan: 'pro' })

    for (const route of ROUTES) {
      const res = await post(route, token)
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'no_live_subscription' })
    }

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  // A cancelled or incomplete subscription is not something to cancel again, downgrade, or
  // resume — SuspendedScreen owns reactivation via Checkout, and a second payment path competing
  // with it is what `LIVE_STATUSES` exists to prevent.
  it('answers 409 for a subscription that is no longer running', async () => {
    await resetMerchant('billing-dead-sub-shop')
    const owner = await makeUser('billing-dead-sub@example.com', 'password123')
    const { token, userId } = await sessionOf(owner)
    const id = await seedMerchant({ slug: 'billing-dead-sub-shop', owner_id: userId, plan: 'pro' })
    await serviceClient().from('merchant_billing').upsert({
      merchant_id: id, stripe_subscription_id: 'sub_dead', status: 'canceled',
    })

    for (const route of ROUTES) {
      expect((await post(route, token)).status).toBe(409)
    }

    await serviceClient().from('merchants').delete().eq('id', id)
  })
})
