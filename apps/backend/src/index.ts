import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { env } from './env.js'
import { admin, getUserFromToken } from './supabase.js'
import { stripe, priceFor, isValidPlan, isValidCycle } from './stripe.js'
import { upsertBilling, setMerchantStatus, billingFromSubscription } from './billing.js'
import { canStartTrial, buildTrialReminderEmail } from './billingLifecycle.js'
import { resendSend } from './email.js'
import { notifyOrderPlaced, telegramSend } from './notify.js'
import { detectRegion, isValidRegion, DEFAULT_REGION } from './region.js'
import { fetchRegionPricing, createPricingCache, type PricingPayload } from './pricing.js'

const app = new Hono()

app.use('/api/*', cors({ origin: env.frontendUrl, allowMethods: ['POST', 'GET', 'OPTIONS'] }))

app.get('/health', (c) => c.json({ ok: true }))

// ── Region-resolved platform subscription pricing ─────────────────────────────
// Country comes from a CDN header (or the `?country=` override for local dev/QA);
// amounts are read from the region's Stripe Prices and cached briefly per region.
const pricingCache = createPricingCache<PricingPayload>({ ttlMs: 5 * 60_000, now: () => Date.now() })

app.get('/api/pricing', async (c) => {
  const region = detectRegion({
    explicitCountry: c.req.query('country') || undefined,
    getHeader: (name) => c.req.header(name),
  })
  try {
    const payload = await pricingCache.get(region, () =>
      fetchRegionPricing(region, {
        prices: env.prices,
        retrievePrice: (id) =>
          stripe.prices
            .retrieve(id)
            .then((p) => ({ unit_amount: p.unit_amount, currency: p.currency })),
      }),
    )
    return c.json(payload)
  } catch (err) {
    console.error('Pricing resolution failed:', err instanceof Error ? err.message : String(err))
    return c.json({ error: 'Pricing unavailable' }, 502)
  }
})

// ── Create a Stripe Checkout Session for the signed-in merchant ────────────────
app.post('/api/checkout', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { plan, billing } = body
  if (!isValidPlan(plan) || !isValidCycle(billing)) {
    return c.json({ error: 'Invalid plan or billing cycle' }, 400)
  }
  // Bill the region the frontend displayed; unknown/absent falls back to default.
  const region = isValidRegion(body.region) ? body.region : DEFAULT_REGION

  // Authenticate the caller via their Supabase JWT.
  const token = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '')
  const user = await getUserFromToken(token)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  // Load the caller's merchant (service role; one merchant per owner).
  const { data: merchant, error } = await admin
    .from('merchants')
    .select('id, name')
    .eq('owner_id', user.id)
    .maybeSingle()
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  if (!merchant) return c.json({ error: 'No merchant for this account' }, 404)

  // Reuse an existing Stripe customer if we have one, else create and store it.
  const { data: existing } = await admin
    .from('merchant_billing')
    .select('stripe_customer_id, status')
    .eq('merchant_id', merchant.id)
    .maybeSingle()

  // A live subscription means there is nothing to buy here — refuse rather
  // than create a second subscription (double-billing), e.g. for a shop an
  // admin suspended while its Stripe subscription is still running.
  if (existing && ['trialing', 'active', 'past_due'].includes(existing.status ?? '')) {
    return c.json({ error: 'This shop already has an active subscription' }, 409)
  }

  let customerId = existing?.stripe_customer_id
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      name: merchant.name,
      metadata: { merchant_id: merchant.id },
    })
    customerId = customer.id
    await upsertBilling(merchant.id, { stripe_customer_id: customerId })
  }

  const metadata = { merchant_id: merchant.id, plan, billing, region }
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceFor(plan, billing, region), quantity: 1 }],
    client_reference_id: merchant.id,
    metadata,
    // No trial here: trials are granted only by superadmin approval (cardless).
    // Checkout is the paid path — pro signup and suspended-shop reactivation.
    subscription_data: { metadata },
    success_url: `${env.frontendUrl}/merchant?checkout=success`,
    cancel_url: `${env.frontendUrl}/merchant/signup?plan=${plan}&billing=${billing}&canceled=1`,
  })

  return c.json({ url: session.url })
})

// ── Superadmin: approve a pending merchant → start its cardless trial ──────────
// Approval (not signup) is the abuse gate: signup alone never puts a live shop
// on the platform. The subscription is created with no payment method and
// cancels itself at trial end (missing_payment_method: 'cancel'), which drives
// the existing subscription.deleted → suspended webhook path. Trials are granted
// here and only here — Checkout never grants one.
app.post('/api/admin/approve-merchant', async (c) => {
  const token = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '')
  const user = await getUserFromToken(token)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const { data: callerProfile } = await admin
    .from('profiles').select('app_role').eq('id', user.id).maybeSingle()
  // TODO(P3): drop the email fallback once superadmin role is seeded (mirrors SessionContext).
  const isSuper = callerProfile?.app_role === 'superadmin' || user.email === 'bitetimeandco@gmail.com'
  if (!isSuper) return c.json({ error: 'Forbidden' }, 403)

  const { merchantId } = await c.req.json().catch(() => ({}))
  if (!merchantId) return c.json({ error: 'Missing merchantId' }, 400)

  const { data: merchant, error } = await admin
    .from('merchants')
    .select('id, name, status, plan, billing_cycle, billing_region, owner_id')
    .eq('id', merchantId)
    .maybeSingle()
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  if (!merchant) return c.json({ error: 'Merchant not found' }, 404)
  if (merchant.status !== 'pending') return c.json({ error: 'Merchant is not pending' }, 409)
  if (merchant.plan === 'pro') {
    return c.json({ error: 'Pro shops activate via payment, not approval' }, 409)
  }

  const { data: billing } = await admin
    .from('merchant_billing').select('*').eq('merchant_id', merchant.id).maybeSingle()

  // Atomically claim the pending merchant so concurrent approvals can't both
  // proceed (double-click, two admin tabs) — first caller wins, later ones 409.
  const { data: claimed, error: claimErr } = await admin
    .from('merchants')
    .update({ status: 'active' })
    .eq('id', merchant.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle()
  if (claimErr) return c.json({ error: 'Claim failed' }, 500)
  if (!claimed) return c.json({ error: 'Merchant is not pending' }, 409)

  if (!canStartTrial(billing)) {
    // Had a subscription once already — approval re-activates, but never re-trials.
    return c.json({ ok: true, trial: false })
  }

  const { data: owner } = await admin
    .from('profiles').select('email').eq('id', merchant.owner_id).maybeSingle()

  const plan = merchant.plan || 'basic'
  const cycle = merchant.billing_cycle || 'monthly'
  const region = isValidRegion(merchant.billing_region) ? merchant.billing_region : DEFAULT_REGION

  // Revert the pending→active claim; never throw from a failure path.
  const revertClaim = async () => {
    try {
      await setMerchantStatus(merchant.id, 'pending')
    } catch (e) {
      console.error('Claim revert failed — merchant left active without a subscription:', e instanceof Error ? e.message : String(e))
    }
  }

  let customerId = billing?.stripe_customer_id
  let sub
  try {
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: owner?.email || undefined,
        name: merchant.name,
        metadata: { merchant_id: merchant.id },
      })
      customerId = customer.id
    }
    sub = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceFor(plan, cycle, region) }],
      trial_period_days: 7,
      trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
      metadata: { merchant_id: merchant.id, plan, billing: cycle, region },
    })
  } catch (err) {
    console.error('Trial subscription creation failed:', err instanceof Error ? err.message : String(err))
    await revertClaim()
    return c.json({ error: 'Subscription creation failed' }, 502)
  }

  try {
    await upsertBilling(merchant.id, billingFromSubscription(sub))
  } catch (err) {
    // The subscription exists but wasn't persisted — cancel it so a retried
    // approval can't mint a second trial against an orphaned live one.
    console.error('Billing persist failed — canceling trial subscription', sub.id, err instanceof Error ? err.message : String(err))
    try {
      await stripe.subscriptions.cancel(sub.id)
    } catch (cancelErr) {
      console.error('Cancel failed — ORPHANED Stripe subscription', sub.id, cancelErr instanceof Error ? cancelErr.message : String(cancelErr))
    }
    await revertClaim()
    return c.json({ error: 'Subscription creation failed' }, 502)
  }

  return c.json({ ok: true, trial: true })
})

// ── Stripe billing portal for the signed-in merchant ───────────────────────────
// Where a trialing merchant adds their card, and a past_due one updates it.
// Requires the portal to be enabled once in the Stripe Dashboard.
app.post('/api/billing/portal', async (c) => {
  const token = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '')
  const user = await getUserFromToken(token)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const { data: merchant } = await admin
    .from('merchants').select('id').eq('owner_id', user.id).maybeSingle()
  if (!merchant) return c.json({ error: 'No merchant for this account' }, 404)
  const { data: billing } = await admin
    .from('merchant_billing').select('stripe_customer_id').eq('merchant_id', merchant.id).maybeSingle()
  if (!billing?.stripe_customer_id) return c.json({ error: 'No billing account yet' }, 404)
  const session = await stripe.billingPortal.sessions.create({
    customer: billing.stripe_customer_id,
    return_url: `${env.frontendUrl}/merchant`,
  })
  return c.json({ url: session.url })
})

// ── Order notification — sends Telegram server-side ────────────────────────────
// The customer is anonymous; abuse is bounded by requiring a real order. The
// token is read from merchant_secrets (service role) and never reaches the client.
app.post('/api/notify/order', async (c) => {
  const { merchantId, orderNumber } = await c.req.json().catch(() => ({}))
  const result = await notifyOrderPlaced(admin, telegramSend, { merchantId, orderNumber })
  if (!result.ok) return c.json(result, result.error === 'order not found' ? 404 : 400)
  return c.json(result)
})

// ── Stripe webhook — authoritative subscription state ──────────────────────────
app.post('/api/stripe/webhook', async (c) => {
  const sig = c.req.header('stripe-signature') || ''
  const raw = await c.req.text() // raw body required for signature verification

  let event
  try {
    event = stripe.webhooks.constructEvent(raw, sig, env.stripeWebhookSecret)
  } catch (err) {
    console.error('Webhook signature verification failed:', err instanceof Error ? err.message : String(err))
    return c.json({ error: 'Invalid signature' }, 400)
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object
        const merchantId = session.metadata?.merchant_id || session.client_reference_id
        if (merchantId && session.subscription) {
          const subscriptionId =
            typeof session.subscription === 'string' ? session.subscription : session.subscription.id
          const sub = await stripe.subscriptions.retrieve(subscriptionId)
          await upsertBilling(merchantId, billingFromSubscription(sub))
          await setMerchantStatus(merchantId, 'active')
        }
        break
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object
        const merchantId = sub.metadata?.merchant_id
        if (merchantId) await upsertBilling(merchantId, billingFromSubscription(sub))
        break
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object
        const merchantId = sub.metadata?.merchant_id
        if (merchantId) {
          // Only the CURRENT subscription's cancellation suspends the shop — a
          // stale or replaced subscription (e.g. the old trial after the shop
          // reactivated via Checkout) must not re-suspend a paying merchant or
          // clobber the billing row.
          const { data: current } = await admin
            .from('merchant_billing')
            .select('stripe_subscription_id')
            .eq('merchant_id', merchantId)
            .maybeSingle()
          if (current?.stripe_subscription_id && current.stripe_subscription_id !== sub.id) break
          await upsertBilling(merchantId, billingFromSubscription(sub))
          await setMerchantStatus(merchantId, 'suspended')
        }
        break
      }
      case 'invoice.payment_failed': {
        const inv = event.data.object
        // Stripe moved `subscription_details` under `invoice.parent` (API
        // version 2025-03-31+). The payload shape follows the ENDPOINT's
        // registered API version, so read the new location with a legacy
        // fallback (same drift-hardening as billingFromSubscription).
        const parent = (inv as { parent?: { subscription_details?: { metadata?: Record<string, string> } } }).parent
        const merchantId =
          (inv as { subscription_details?: { metadata?: Record<string, string> } }).subscription_details?.metadata?.merchant_id ||
          parent?.subscription_details?.metadata?.merchant_id ||
          inv.metadata?.merchant_id
        if (merchantId) await upsertBilling(merchantId, { status: 'past_due' })
        break
      }
      case 'customer.subscription.trial_will_end': {
        // Fires 72h before trial end — the out-of-app reminder. A thrown send
        // error 500s the webhook so Stripe retries delivery.
        const sub = event.data.object
        const merchantId = sub.metadata?.merchant_id
        if (merchantId && sub.trial_end) {
          const { data: merchant } = await admin
            .from('merchants').select('name, owner_id').eq('id', merchantId).maybeSingle()
          const { data: owner } = merchant?.owner_id
            ? await admin.from('profiles').select('email').eq('id', merchant.owner_id).maybeSingle()
            : { data: null }
          if (owner?.email) {
            const { subject, text } = buildTrialReminderEmail({
              shopName: merchant?.name || 'your shop',
              trialEndsAt: new Date(sub.trial_end * 1000).toISOString(),
              dashboardUrl: `${env.frontendUrl}/merchant`,
            })
            await resendSend(owner.email, subject, text)
          }
        }
        break
      }
      default:
        break // ignore unhandled event types
    }
  } catch (err) {
    console.error(`Error handling ${event.type}:`, err instanceof Error ? err.message : String(err))
    return c.json({ error: 'Handler error' }, 500)
  }

  return c.json({ received: true })
})

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`BiteTime billing server on http://localhost:${info.port}`)
})
