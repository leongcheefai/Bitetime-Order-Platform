// tests/api/webhook-plan.test.ts
// POST /api/stripe/webhook — plan reconciliation (#112). The first test this handler has ever
// had, and it exists for the WIRING, not the arithmetic: `planFromPriceId` is unit-tested in
// tests/unit/pricing.test.ts, but nothing there can catch reading the wrong field off the
// subscription, or writing `merchant_billing` where `merchants` was meant. So this drives a
// real signed event through the real route and asserts what landed in Postgres.
//
// Network-free by construction: `generateTestHeaderString` signs offline against the stubbed
// webhook secret, and the `customer.subscription.updated` branch only calls Stripe when
// `default_payment_method` is null (the customer-default fallback in app.ts) — so every fixture
// here sets it. `checkout.session.completed` is deliberately NOT covered: it calls
// `stripe.subscriptions.retrieve()`, which is a real API call.
import { describe, it, expect } from 'vitest'
import Stripe from 'stripe'
import { app } from '../../src/app.js'
import { makeUser, seedMerchant, serviceClient, resetMerchant } from '../rls/helpers.js'

const PRICES = {
  basicMonthly: process.env.STRIPE_PRICE_BASIC_MONTHLY!,
  proMonthly: process.env.STRIPE_PRICE_PRO_MONTHLY!,
  proYearly: process.env.STRIPE_PRICE_PRO_YEARLY!,
}

// The webhook is signed, not bearer-authenticated, so these suites need the owner's id to seed
// a merchant and nothing else — no token anywhere in this file.
async function userIdOf(client: Awaited<ReturnType<typeof makeUser>>) {
  const { data } = await client.auth.getSession()
  return data.session!.user.id
}

/**
 * A `customer.subscription.updated` event carrying one price, signed the way Stripe signs.
 * `default_payment_method` is always set — see the file header.
 */
function subscriptionUpdated(merchantId: string, priceId: string) {
  return {
    id: 'evt_test_plan',
    object: 'event',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_test_plan',
        object: 'subscription',
        customer: 'cus_test_plan',
        status: 'active',
        default_payment_method: 'pm_test_card',
        trial_end: null,
        metadata: { merchant_id: merchantId },
        items: {
          object: 'list',
          data: [{ id: 'si_test', price: { id: priceId }, current_period_end: 1893456000 }],
        },
      },
    },
  }
}

function postWebhook(payload: unknown) {
  const body = JSON.stringify(payload)
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: process.env.STRIPE_WEBHOOK_SECRET!,
  })
  return app.request('/api/stripe/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
    body,
  })
}

async function planOf(merchantId: string) {
  const { data } = await serviceClient()
    .from('merchants').select('plan, billing_cycle').eq('id', merchantId).single()
  return data!
}

describe('POST /api/stripe/webhook — plan reconciliation', () => {
  // The upgrade this whole issue exists for: the merchant swaps price in the Customer Portal,
  // Stripe fires this event, and the shop must actually BECOME pro — otherwise it has paid for
  // features the #110 gate still refuses.
  it('promotes a basic shop to pro when the subscription carries the pro price', async () => {
    await resetMerchant('wh-upgrade-shop')
    const owner = await makeUser('wh-upgrade@example.com', 'password123')
    const userId = await userIdOf(owner)
    const id = await seedMerchant({ slug: 'wh-upgrade-shop', owner_id: userId, plan: 'basic' })

    const res = await postWebhook(subscriptionUpdated(id, PRICES.proMonthly))
    expect(res.status).toBe(200)

    expect(await planOf(id)).toEqual({ plan: 'pro', billing_cycle: 'monthly' })

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  // The same event runs the other way when a scheduled downgrade finally executes.
  it('returns a pro shop to basic when the subscription carries the basic price', async () => {
    await resetMerchant('wh-downgrade-shop')
    const owner = await makeUser('wh-downgrade@example.com', 'password123')
    const userId = await userIdOf(owner)
    const id = await seedMerchant({ slug: 'wh-downgrade-shop', owner_id: userId, plan: 'pro' })

    const res = await postWebhook(subscriptionUpdated(id, PRICES.basicMonthly))
    expect(res.status).toBe(200)

    expect((await planOf(id)).plan).toBe('basic')

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  // `billing_cycle` was never reconciled before this: a monthly→yearly switch in the portal
  // left the column saying monthly forever.
  it('repairs billing_cycle from the price, not just the plan', async () => {
    await resetMerchant('wh-cycle-shop')
    const owner = await makeUser('wh-cycle@example.com', 'password123')
    const userId = await userIdOf(owner)
    const id = await seedMerchant({ slug: 'wh-cycle-shop', owner_id: userId, plan: 'pro' })
    await serviceClient().from('merchants').update({ billing_cycle: 'monthly' }).eq('id', id)

    const res = await postWebhook(subscriptionUpdated(id, PRICES.proYearly))
    expect(res.status).toBe(200)

    expect(await planOf(id)).toEqual({ plan: 'pro', billing_cycle: 'yearly' })

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  // LOAD-BEARING. An unrecognised price must leave the row ALONE. Defaulting to basic here
  // would let a hand-made price in the Stripe dashboard silently strip a paying Pro shop of
  // every feature it pays for — a far worse failure than a stale column.
  it('leaves the plan untouched when the price is not one of ours', async () => {
    await resetMerchant('wh-unknown-price-shop')
    const owner = await makeUser('wh-unknown-price@example.com', 'password123')
    const userId = await userIdOf(owner)
    const id = await seedMerchant({ slug: 'wh-unknown-price-shop', owner_id: userId, plan: 'pro' })

    const res = await postWebhook(subscriptionUpdated(id, 'price_made_by_hand_in_the_dashboard'))
    expect(res.status).toBe(200)

    expect((await planOf(id)).plan).toBe('pro')

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  // The signature check is the only thing standing between this endpoint and anyone on the
  // internet handing themselves a Pro subscription with a curl.
  it('refuses an unsigned body and changes nothing', async () => {
    await resetMerchant('wh-unsigned-shop')
    const owner = await makeUser('wh-unsigned@example.com', 'password123')
    const userId = await userIdOf(owner)
    const id = await seedMerchant({ slug: 'wh-unsigned-shop', owner_id: userId, plan: 'basic' })

    const res = await app.request('/api/stripe/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscriptionUpdated(id, PRICES.proMonthly)),
    })
    expect(res.status).toBe(400)

    expect((await planOf(id)).plan).toBe('basic')

    await serviceClient().from('merchants').delete().eq('id', id)
  })
})
