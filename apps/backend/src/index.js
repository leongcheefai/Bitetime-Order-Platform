import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { env } from './env.js'
import { admin, getUserFromToken } from './supabase.js'
import { stripe, priceFor, isValidPlan, isValidCycle } from './stripe.js'
import { upsertBilling, setMerchantStatus, billingFromSubscription } from './billing.js'

const app = new Hono()

app.use('/api/*', cors({ origin: env.frontendUrl, allowMethods: ['POST', 'GET', 'OPTIONS'] }))

app.get('/health', (c) => c.json({ ok: true }))

// ── Create a Stripe Checkout Session for the signed-in merchant ────────────────
app.post('/api/checkout', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { plan, billing } = body
  if (!isValidPlan(plan) || !isValidCycle(billing)) {
    return c.json({ error: 'Invalid plan or billing cycle' }, 400)
  }

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
    .select('stripe_customer_id')
    .eq('merchant_id', merchant.id)
    .maybeSingle()

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

  const metadata = { merchant_id: merchant.id, plan, billing }
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceFor(plan, billing), quantity: 1 }],
    client_reference_id: merchant.id,
    metadata,
    payment_method_collection: 'always', // card upfront even for the Basic trial
    subscription_data: {
      metadata,
      ...(plan === 'basic' ? { trial_period_days: 7 } : {}),
    },
    success_url: `${env.frontendUrl}/merchant?checkout=success`,
    cancel_url: `${env.frontendUrl}/merchant/signup?plan=${plan}&billing=${billing}&canceled=1`,
  })

  return c.json({ url: session.url })
})

// ── Stripe webhook — authoritative subscription state ──────────────────────────
app.post('/api/stripe/webhook', async (c) => {
  const sig = c.req.header('stripe-signature')
  const raw = await c.req.text() // raw body required for signature verification

  let event
  try {
    event = stripe.webhooks.constructEvent(raw, sig, env.stripeWebhookSecret)
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message)
    return c.json({ error: 'Invalid signature' }, 400)
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object
        const merchantId = session.metadata?.merchant_id || session.client_reference_id
        if (merchantId && session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription)
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
          await upsertBilling(merchantId, billingFromSubscription(sub))
          await setMerchantStatus(merchantId, 'suspended')
        }
        break
      }
      case 'invoice.payment_failed': {
        const inv = event.data.object
        const merchantId = inv.subscription_details?.metadata?.merchant_id || inv.metadata?.merchant_id
        if (merchantId) await upsertBilling(merchantId, { status: 'past_due' })
        break
      }
      default:
        break // ignore unhandled event types
    }
  } catch (err) {
    console.error(`Error handling ${event.type}:`, err.message)
    return c.json({ error: 'Handler error' }, 500)
  }

  return c.json({ received: true })
})

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`BiteTime billing server on http://localhost:${info.port}`)
})
