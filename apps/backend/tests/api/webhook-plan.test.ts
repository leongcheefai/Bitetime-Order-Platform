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
function subscriptionUpdated(
  merchantId: string,
  priceId: string,
  over: Record<string, unknown> = {},
) {
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
        ...over,
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

  // THE bug the cancel work exists for. Stripe leaves `status` on 'active' for a subscription
  // cancelling at period end, so without this flag the Subscription tab went on promising
  // "Renews on 1 Sep" right up to the morning `customer.subscription.deleted` suspended the shop.
  it('records that a subscription is cancelling at period end', async () => {
    await resetMerchant('wh-cancelling-shop')
    const owner = await makeUser('wh-cancelling@example.com', 'password123')
    const id = await seedMerchant({ slug: 'wh-cancelling-shop', owner_id: await userIdOf(owner), plan: 'pro' })

    const event = subscriptionUpdated(id, PRICES.proMonthly, { cancel_at_period_end: true })
    expect((await postWebhook(event)).status).toBe(200)

    const { data } = await serviceClient()
      .from('merchant_billing').select('status, cancel_at_period_end').eq('merchant_id', id).single()
    // Status stays 'active' — which is exactly why the flag has to be stored separately.
    expect(data).toMatchObject({ status: 'active', cancel_at_period_end: true })

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  // ── Artifact cutoff ─────────────────────────────────────────────────────────
  // #110 gated only the WRITES, which left the reverse direction open: a shop that had been Pro
  // kept its vouchers redeemable and its promos discounting forever, because the order path is
  // plan-blind by design. The cutoff is data-level and fires here, once, at the transition —
  // never as a plan check inside the priced order transaction.
  it('deactivates vouchers and ends running promos when a shop drops to basic', async () => {
    await resetMerchant('wh-artifacts-shop')
    const owner = await makeUser('wh-artifacts@example.com', 'password123')
    const id = await seedMerchant({ slug: 'wh-artifacts-shop', owner_id: await userIdOf(owner), plan: 'pro' })
    const svc = serviceClient()
    await svc.from('vouchers').insert({ merchant_id: id, code: 'SAVE10', kind: 'percent', amount: 10 })
    // No end date and no cap: a sale that would otherwise run forever, which is exactly the
    // case a naive "expire what has an end date" cutoff would miss.
    await svc.from('products').insert({
      merchant_id: id, name: 'Matcha Cookie', price: 13, promo_price: 8, promo_end: null,
    })

    expect((await postWebhook(subscriptionUpdated(id, PRICES.basicMonthly))).status).toBe(200)

    const { data: vouchers } = await svc.from('vouchers').select('active').eq('merchant_id', id)
    expect(vouchers!.map(v => v.active)).toEqual([false])
    const { data: products } = await svc.from('products').select('promo_price, promo_end').eq('merchant_id', id)
    // The configured price survives — the merchant's own record of what the sale was — while the
    // end date moves to now, which is what `promoState` already reads as "no promo".
    expect(Number(products![0].promo_price)).toBe(8)
    expect(new Date(products![0].promo_end as string).getTime()).toBeLessThanOrEqual(Date.now())

    await svc.from('merchants').delete().eq('id', id)
  })

  // The `.or(promo_end.is.null, promo_end.gt.<now>)` half of the promo cutoff. A sale that had
  // already finished must keep its historical end date: rewriting it would relabel last month's
  // promotion as having ended at the downgrade, corrupting the merchant's own record of when
  // they sold at what price.
  it('does not rewrite the end date of a promo that had already finished', async () => {
    await resetMerchant('wh-old-promo-shop')
    const owner = await makeUser('wh-old-promo@example.com', 'password123')
    const id = await seedMerchant({ slug: 'wh-old-promo-shop', owner_id: await userIdOf(owner), plan: 'pro' })
    const svc = serviceClient()
    const ENDED = '2026-01-01T00:00:00+00:00'
    await svc.from('products').insert({
      merchant_id: id, name: 'Last Year Sale', price: 13, promo_price: 8, promo_end: ENDED,
    })

    expect((await postWebhook(subscriptionUpdated(id, PRICES.basicMonthly))).status).toBe(200)

    const { data } = await svc.from('products').select('promo_end').eq('merchant_id', id).single()
    expect(new Date(data!.promo_end as string).toISOString()).toBe(new Date(ENDED).toISOString())

    await svc.from('merchants').delete().eq('id', id)
  })

  // LOAD-BEARING. Every renewal of a Basic shop replays this event. A cutoff keyed on "is this
  // shop basic" rather than on the TRANSITION would re-deactivate vouchers the merchant had
  // re-enabled — silently, once a month, forever.
  it('leaves a basic shop\'s vouchers alone when it merely renews', async () => {
    await resetMerchant('wh-renew-shop')
    const owner = await makeUser('wh-renew@example.com', 'password123')
    const id = await seedMerchant({ slug: 'wh-renew-shop', owner_id: await userIdOf(owner), plan: 'basic' })
    const svc = serviceClient()
    await svc.from('vouchers').insert({ merchant_id: id, code: 'STILLGOOD', kind: 'percent', amount: 10 })

    expect((await postWebhook(subscriptionUpdated(id, PRICES.basicMonthly))).status).toBe(200)

    const { data } = await svc.from('vouchers').select('active').eq('merchant_id', id)
    expect(data!.map(v => v.active)).toEqual([true])

    await svc.from('merchants').delete().eq('id', id)
  })

  // The scheduled change has landed, so the intent is spent. A `pending_plan` left behind would
  // keep the Subscription tab saying "Switching to Basic on…" after it already had.
  it('clears the pending plan once the change has happened', async () => {
    await resetMerchant('wh-pending-shop')
    const owner = await makeUser('wh-pending@example.com', 'password123')
    const id = await seedMerchant({ slug: 'wh-pending-shop', owner_id: await userIdOf(owner), plan: 'pro' })
    const svc = serviceClient()
    await svc.from('merchant_billing').upsert({ merchant_id: id, pending_plan: 'basic', status: 'active' })

    expect((await postWebhook(subscriptionUpdated(id, PRICES.basicMonthly))).status).toBe(200)

    const { data } = await svc.from('merchant_billing').select('pending_plan').eq('merchant_id', id).single()
    expect(data!.pending_plan).toBeNull()

    await svc.from('merchants').delete().eq('id', id)
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
