// The Hono app, with no server attached.
//
// It is exported rather than served here so the suites in tests/api can drive the real
// routes in-process via `app.request()` — no listening port, no HTTP stack, but the actual
// routing, auth and error mapping under test. src/index.ts is the entry that binds it to a
// port.
//
// Importing this does no I/O, but it is not free of side effects: it pulls in env.ts, which
// THROWS on a missing required var. That fail-fast is deliberate (a backend that boots
// without a Stripe key is worse than one that refuses to), and it is why vitest.db.config.ts
// has to stub the Stripe keys before a test can import this module. Keep it to that — no
// connections, no timers, no reads at import time.
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { env } from './env.js'
import { admin, getUserFromToken } from './supabase.js'
import { stripe, priceFor, isValidPlan, isValidCycle } from './stripe.js'
import { upsertBilling, setMerchantStatus, billingFromSubscription } from './billing.js'
import { canStartTrial, buildTrialReminderEmail } from './billingLifecycle.js'
import { resendSend } from './email.js'
import { notifyOrderPlaced, telegramSend } from './notify.js'
import { signUpCustomer, isDuplicateEmailError } from './customerSignup.js'
import { createSlidingWindow } from './rateLimit.js'
import { clientIp } from './clientIp.js'
import { detectRegion, isValidRegion, DEFAULT_REGION } from './region.js'
import { fetchRegionPricing, createPricingCache, type PricingPayload } from './pricing.js'
import { listReferredShops } from './referrals.js'
import { trackOrder } from './orderTracking.js'
import { placeOrder, OrderError } from './orders.js'

export const app = new Hono()

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
  const { merchantId } = await c.req.json().catch(() => ({}))
  if (!merchantId) return c.json({ error: 'Missing merchantId' }, 400)

  // These reads are independent — the caller's identity (auth → profile) gates the
  // mutation, while the target merchant + its billing load in parallel. merchant_billing
  // keys on the merchants PK, so both use merchantId directly. Run them concurrently to
  // save cross-network round-trips (Railway → Supabase); nothing is mutated until authz passes.
  const authPromise = getUserFromToken(token).then(async (user) => {
    if (!user) return { user: null, profile: null }
    // profiles identity lives in user_id (id is a surrogate PK since the P0 restructure).
    const { data: profile } = await admin
      .from('profiles').select('app_role').eq('user_id', user.id).maybeSingle()
    return { user, profile }
  })
  const [{ user, profile }, merchantRes, billingRes] = await Promise.all([
    authPromise,
    admin
      .from('merchants')
      .select('id, name, status, plan, billing_cycle, billing_region, owner_id')
      .eq('id', merchantId)
      .maybeSingle(),
    admin.from('merchant_billing').select('*').eq('merchant_id', merchantId).maybeSingle(),
  ])

  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  // TODO(P3): drop the email fallback once superadmin role is seeded (mirrors SessionContext).
  const isSuper = profile?.app_role === 'superadmin' || user.email === 'bitetime@praxor.dev'
  if (!isSuper) return c.json({ error: 'Forbidden' }, 403)

  const { data: merchant, error } = merchantRes
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  if (!merchant) return c.json({ error: 'Merchant not found' }, 404)
  if (merchant.status !== 'pending') return c.json({ error: 'Merchant is not pending' }, 409)
  if (merchant.plan === 'pro') {
    return c.json({ error: 'Pro shops activate via payment, not approval' }, 409)
  }

  const { data: billing } = billingRes

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

  // Owner email comes from Auth, not profiles — the profiles row may not exist
  // (client-side profile upsert is currently RLS-blocked for new signups).
  const { data: ownerUser } = await admin.auth.admin.getUserById(merchant.owner_id)
  const ownerEmail = ownerUser?.user?.email

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
        email: ownerEmail || undefined,
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

// ── Superadmin: manual suspend / reject / reactivate ───────────────────────────
// merchants.status is service_role-only at the DB layer (guard_merchant_status),
// so the admin console can no longer flip it through PostgREST — these writes must
// come through here. Covers Reject (pending→suspended), Suspend (active→suspended),
// and Reactivate (suspended→active). Trial-granting stays in approve-merchant.
app.post('/api/admin/set-merchant-status', async (c) => {
  const token = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '')
  const user = await getUserFromToken(token)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const { data: callerProfile } = await admin
    .from('profiles').select('app_role').eq('user_id', user.id).maybeSingle()
  // TODO(P3): drop the email fallback once superadmin role is seeded (mirrors approve-merchant).
  const isSuper = callerProfile?.app_role === 'superadmin' || user.email === 'bitetime@praxor.dev'
  if (!isSuper) return c.json({ error: 'Forbidden' }, 403)

  const { merchantId, status } = await c.req.json().catch(() => ({}))
  if (!merchantId) return c.json({ error: 'Missing merchantId' }, 400)
  // 'pending' is never a manual target — it is reached only by revert paths.
  if (status !== 'active' && status !== 'suspended') {
    return c.json({ error: 'status must be active or suspended' }, 400)
  }

  const { data: merchant } = await admin
    .from('merchants').select('id').eq('id', merchantId).maybeSingle()
  if (!merchant) return c.json({ error: 'Merchant not found' }, 404)

  try {
    await setMerchantStatus(merchantId, status)
  } catch (err) {
    console.error('set-merchant-status failed:', err instanceof Error ? err.message : String(err))
    return c.json({ error: 'Status update failed' }, 500)
  }
  return c.json({ ok: true, status })
})

// ── Superadmin: comp a merchant to free Pro (no Stripe payment) ────────────────
// Grants active + pro without any Stripe subscription — for partners, staff, and
// promo shops. Writes an 'active' billing row with a far-future period end and no
// trial, so the trial/past-due banners stay silent and nothing expires the shop.
// The shop is decoupled from Stripe: it has no real subscription, so the
// webhook-driven suspension path never touches it. Revoke by suspending in the
// console (set-merchant-status → suspended). If the merchant already carries a
// real Stripe subscription this overwrites its local status to active — don't comp
// a paying shop.
app.post('/api/admin/comp-merchant', async (c) => {
  const token = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '')
  const user = await getUserFromToken(token)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const { data: callerProfile } = await admin
    .from('profiles').select('app_role').eq('user_id', user.id).maybeSingle()
  // TODO(P3): drop the email fallback once superadmin role is seeded (mirrors approve-merchant).
  const isSuper = callerProfile?.app_role === 'superadmin' || user.email === 'bitetime@praxor.dev'
  if (!isSuper) return c.json({ error: 'Forbidden' }, 403)

  const { merchantId } = await c.req.json().catch(() => ({}))
  if (!merchantId) return c.json({ error: 'Missing merchantId' }, 400)

  const { data: merchant } = await admin
    .from('merchants').select('id').eq('id', merchantId).maybeSingle()
  if (!merchant) return c.json({ error: 'Merchant not found' }, 404)

  // Activate + mark pro. Service role bypasses the guard_merchant_status trigger.
  const { error: mErr } = await admin
    .from('merchants').update({ status: 'active', plan: 'pro' }).eq('id', merchantId)
  if (mErr) {
    console.error('comp-merchant merchants update failed:', mErr.message)
    return c.json({ error: 'Comp failed' }, 500)
  }

  // Silence billing banners: active status, far-future period end, no trial. Merge
  // (upsert) so any existing stripe_customer_id survives, but the local state reads active.
  try {
    const farFuture = new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000).toISOString()
    await upsertBilling(merchantId, {
      status: 'active',
      trial_ends_at: null,
      current_period_end: farFuture,
    })
  } catch (err) {
    console.error('comp-merchant billing upsert failed:', err instanceof Error ? err.message : String(err))
    return c.json({ error: 'Comp failed' }, 500)
  }

  return c.json({ ok: true })
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

// ── Customer sign-up — creates the account pre-confirmed ───────────────────────
// Email confirmation stays ON project-wide (it is shared with merchants, who own shops
// and Stripe billing), so a client-side signUp returns no session and strands a customer
// in their inbox holding a cart. Created here with the service role instead, pre-confirmed,
// and the client signs in normally. See src/customerSignup.ts for what that costs.
//
// RATE LIMITING — read before touching the deploy shape:
// The window below lives in this process's memory. That works only because the backend is
// a long-lived Node process (`node dist/server.js` + @hono/node-server), and it comes with
// two consequences:
//   • it resets on redeploy — harmless;
//   • it SILENTLY STOPS PROTECTING ANYTHING if the backend is ever scaled past one
//     instance, or moved to serverless. Each instance would count its own hits, and this
//     endpoint goes around Supabase's own sign-up rate limits by design. If that day comes,
//     move the counter to a shared store (or put a captcha in front).
// CORS is not the guard: /api/* is pinned to env.frontendUrl, but that only constrains
// browsers — any server can POST here. The rate limit is the control.
// Escalation, if abuse ever actually happens, is a captcha — deliberately not now, because
// a captcha widget in the checkout path costs orders.
const signupIpWindow = createSlidingWindow({ limit: 10, windowMs: 60 * 60_000, now: () => Date.now() })
const signupEmailWindow = createSlidingWindow({ limit: 3, windowMs: 60 * 60_000, now: () => Date.now() })

// ── Referred shops ────────────────────────────────────────────────────────────
// Replaces the my_referred_shops SECURITY DEFINER function. That function could read
// across tenants — it had to, since a referrer's shops are not their own — and was safe
// only because it filtered on a code derived from auth.uid(), which the caller could not
// choose. The same property holds here: the code comes from the verified JWT and from
// nothing else. Do not add a code parameter to this route.
app.get('/api/referrals/shops', async (c) => {
  const token = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '')
  const user = await getUserFromToken(token)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  return c.json(await listReferredShops(user.id))
})

app.post('/api/customer/signup', async (c) => {
  const { email, password } = await c.req.json().catch(() => ({}))
  // Anything else the body carries — a role, a merchant_id — is ignored: only email and
  // password are read, createUser mints a plain auth user, and the profile row below pins
  // app_role itself. So this endpoint cannot manufacture a merchant or a superadmin.
  // @hono/node-server hangs the raw Node request off `c.env`, but types it as {} — the
  // socket address is the fallback when no proxy header is present (i.e. local dev).
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming
  const ip = clientIp(
    { 'x-forwarded-for': c.req.header('x-forwarded-for'), 'cf-connecting-ip': c.req.header('cf-connecting-ip') },
    incoming?.socket?.remoteAddress,
  )

  const result = await signUpCustomer(
    {
      allow: (kind, value) => (kind === 'ip' ? signupIpWindow : signupEmailWindow).allow(value),
      logError: (message) => console.error(message),
      createUser: async ({ email, password }) => {
        const { data, error } = await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true, // pre-confirmed — regressing this reintroduces the mid-checkout dead end
        })
        if (error || !data?.user) {
          if (isDuplicateEmailError(error)) return { ok: false, reason: 'duplicate_email' }
          console.error('Customer createUser failed:', error?.message ?? 'no user returned')
          return { ok: false, reason: 'error' }
        }
        return { ok: true, userId: data.user.id }
      },
      writeProfile: async ({ userId, email }) => {
        // Mirrors the client's ensureGlobalProfile: the global profile is the row with a null
        // merchant_id, and the only unique index on user_id alone is partial, so upsert can't
        // target it — select, then insert if absent. Idempotent by design; the client repeats
        // this on SIGNED_IN as a safety net, and that repeat is also what fills referral_code
        // (derived client-side from the uid).
        //
        // app_role is written explicitly rather than left to the column default: this insert
        // runs as service_role, which guard_profile_privileges deliberately exempts
        // (20260627120300_guard_profile_privileges.sql), so the trigger that would otherwise
        // force 'customer' never fires here. Naming it keeps a future extra field from
        // silently minting a superadmin.
        const { data: existing } = await admin
          .from('profiles').select('id').eq('user_id', userId).is('merchant_id', null).maybeSingle()
        if (existing) return
        const { error } = await admin.from('profiles').insert({
          user_id: userId,
          name: email.split('@')[0],
          email,
          email_confirmed: true,
          app_role: 'customer',
          created_at: new Date().toISOString(),
        })
        if (error) throw new Error(error.message)
      },
    },
    { email, password, ip },
  )

  if (!result.ok) return c.json({ error: result.error }, result.status)
  return c.json({ ok: true })
})

// ── Order intake — counter, voucher, PRICE and order in ONE transaction ───────
// The JWT is OPTIONAL: guest checkout is a first-class path and must keep working.
//
// The body carries a cart and the total the customer saw. It carries NO prices: every number
// on the order is derived from Postgres inside placeOrder. It used to carry `total`, which
// meant any client could POST total: 0 and have the order commit at zero.
//
// Attribution comes from the token and from nowhere else. `user_id` is never read from the
// body — see placeOrder's contract for why that is a security property rather than a tidiness
// one.
app.post('/api/orders', async (c) => {
  const bodyJson = await c.req.json().catch(() => null)
  if (!bodyJson || typeof bodyJson !== 'object') return c.json({ error: 'invalid_body' }, 400)

  const token = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '')
  // No token is a guest, not a rejection. A token that is present but bad is also a guest:
  // the alternative is a checkout that dies on an expired session the customer cannot see.
  const user = token ? await getUserFromToken(token) : null

  const b = bodyJson as Record<string, unknown>

  // A cart is ids → positive whole quantities. Reject a malformed one rather than coercing it:
  // `Number('abc')` is NaN, which sails past TypeScript, reaches Postgres and comes back a 500
  // — a bad request dressed up as a server fault.
  const isCart = (v: unknown): v is Record<string, number> =>
    !!v && typeof v === 'object' && !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every(
      q => typeof q === 'number' && Number.isInteger(q) && q > 0,
    ) &&
    Object.keys(v as Record<string, unknown>).length > 0

  const quotedTotal = typeof b.quotedTotal === 'number' && Number.isFinite(b.quotedTotal)
    ? b.quotedTotal
    : null

  // An ALLOWLIST, not a string check: `mode` SELECTS THE SHIPPING FEE. Any value other than
  // 'delivery' prices shipping at 0, so a free string is a client-chosen value that zeroes a
  // fee — the same hole as a client-supplied `total`, and `mode: 'sameday'` walked straight
  // through it with an address attached.
  //
  // 'sameday' is DELIBERATELY not here: it is unreachable from the Storefront (which offers
  // exactly these two) and has no rate behind it. Adding it back without a real fee re-opens
  // the hole.
  const mode = b.mode === 'pickup' || b.mode === 'delivery' ? b.mode : null

  if (
    typeof b.merchantId !== 'string' || !b.merchantId ||
    typeof b.customerName !== 'string' ||
    typeof b.customerWa !== 'string' ||
    mode === null ||
    !isCart(b.cart) ||
    quotedTotal === null
  ) {
    return c.json({ error: 'invalid_body' }, 400)
  }

  try {
    const result = await placeOrder({
      merchantId: b.merchantId,
      userId: user?.id ?? null,
      customerName: b.customerName,
      customerWa: b.customerWa,
      mode,
      address: b.address ?? null,
      cart: b.cart,
      quotedTotal,
      voucherCode: typeof b.voucherCode === 'string' ? b.voucherCode : null,
      voucherEntry: typeof b.voucherEntry === 'string' ? b.voucherEntry : null,
    })
    return c.json(result)
  } catch (err) {
    // A refusal the customer can act on — a closed shop, a spent voucher, a price that moved —
    // carries its code so the storefront can say which, and can offer the right retry. Anything
    // else is a bug, and must not be dressed up as a domain error the customer can "fix".
    if (err instanceof OrderError) {
      return c.json({ error: err.code }, err.code === 'merchant_not_found' ? 404 : 409)
    }
    console.error('Order intake failed:', err instanceof Error ? err.message : String(err))
    return c.json({ error: 'order_failed' }, 500)
  }
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

// ── Guest order tracking ──────────────────────────────────────────────────────
// Replaces the track_order SECURITY DEFINER function. Unauthenticated on purpose: tracking
// a guest order without an account is the entire point of it.
//
// Every miss — wrong number, wrong phone, missing field, unparseable body — is the SAME bare
// null with the SAME 200. That uniformity is the security property. Order numbers are a
// per-shop daily counter and therefore guessable; the phone is what makes a guess cost ~10^8
// tries instead of one, and a response that tells "no such order" apart from "wrong phone"
// hands back exactly the enumeration oracle the phone exists to remove. Do not add a helpful
// error message here, and do not 404 the miss.
app.post('/api/orders/track', async (c) => {
  const { merchantId, orderNumber, phone } = await c.req.json().catch(() => ({}))
  if (typeof merchantId !== 'string' || typeof orderNumber !== 'string' || typeof phone !== 'string') {
    return c.json(null)
  }

  try {
    return c.json(await trackOrder(merchantId, orderNumber, phone))
  } catch (err) {
    // A merchantId that is not a uuid makes Postgres throw, and an uncaught throw is a 500 —
    // a response that says "your order number was real, your merchant was not". Same null,
    // logged for the operator rather than reported to the caller. This is also what the RPC
    // it replaces did: PostgREST errored, and the browser turned any error into a null.
    console.error('Order tracking failed:', err instanceof Error ? err.message : String(err))
    return c.json(null)
  }
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
        if (merchantId) {
          const fields = billingFromSubscription(sub)
          // The Customer Portal often stores an added card as the customer default
          // rather than on the subscription, leaving sub.default_payment_method null.
          // Resolve that so a merchant who added a card stops seeing the nag banner.
          if (!fields.has_payment_method) {
            const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
            const customer = await stripe.customers.retrieve(customerId)
            if (!('deleted' in customer) && customer.invoice_settings?.default_payment_method) {
              fields.has_payment_method = true
            }
          }
          await upsertBilling(merchantId, fields)
        }
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
          // Owner email from Auth, not profiles — the profiles row may not exist
          // (client-side profile upsert is currently RLS-blocked for new signups).
          const { data: ownerUser } = merchant?.owner_id
            ? await admin.auth.admin.getUserById(merchant.owner_id)
            : { data: { user: null } }
          const ownerEmail = ownerUser?.user?.email
          if (ownerEmail) {
            const { subject, text } = buildTrialReminderEmail({
              shopName: merchant?.name || 'your shop',
              trialEndsAt: new Date(sub.trial_end * 1000).toISOString(),
              dashboardUrl: `${env.frontendUrl}/merchant`,
            })
            await resendSend(ownerEmail, subject, text)
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
