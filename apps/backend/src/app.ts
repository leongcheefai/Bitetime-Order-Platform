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
import { requireUser, requireSuperadmin, requireMerchantOwns, type AppEnv } from './mw.js'
import { stripe, priceFor, isValidPlan, isValidCycle } from './stripe.js'
import { upsertBilling, setMerchantStatus, billingFromSubscription } from './billing.js'
import { canStartTrial, buildTrialReminderEmail } from './billingLifecycle.js'
import { resendSend } from './email.js'
import { notifyOrderPlaced, telegramSend } from './notify.js'
import { signUpCustomer, isDuplicateEmailError } from './customerSignup.js'
import { createSlidingWindow } from './rateLimit.js'
import { clientIp } from './clientIp.js'
import { resolveDistance, CACHE_TTL_MS } from './distance.js'
import { liveDistanceDeps } from './distanceCache.js'
import { googlePlaceSuggest, googlePlaceDetail } from './maps.js'
import { detectCountry } from './region.js'
import { fetchBasePricing, createPricingCache, type PricingPayload } from './pricing.js'
import { estimateFor } from './fx.js'
import { listReferredShops, listEarnedRewards } from './referrals.js'
import { processReferralReward } from './referralRewardGrant.js'
import { trackOrder } from './orderTracking.js'
import { placeOrder, OrderError } from './orders.js'
import { insertFeedback, listFeedback, updateFeedbackStatus } from './feedback.js'
import { isCart, validateFeedback, isFeedbackStatus, shopDistance, routedKm, distanceFee, exceedsMaxKm } from '@bitetime/shared'
import { resolveSlug, orderPrefix, referralCodeOf, resolveReferredByCode, RESERVED_SLUGS } from './slug.js'
import { pickMerchantConfig, pickProfileFields, pickProductFields, pickOrderFields, ORDER_STATUSES } from './writes.js'

export const app = new Hono<AppEnv>()

app.use('/api/*', cors({ origin: env.frontendUrl, allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'] }))

const ORDER_HISTORY_LIMIT = 20

app.get('/health', (c) => c.json({ ok: true }))

/**
 * The server's clock, published.
 *
 * `priceOrder` runs on both sides of the wire and the promo window reads a clock, so the CLOCK is
 * a price input — and a browser minutes off ours, on the promo's last day, would quote the promo,
 * be refused (`price_changed`), re-quote with the same skewed clock, and be refused again: a
 * permanent refusal loop for a legitimate customer. The storefront syncs against this and prices
 * against the corrected time, so the clock it quotes with is the clock we charge with. See #69.
 */
app.get('/api/time', (c) => c.json({ now: new Date().toISOString() }))

// ── Platform subscription pricing ───────────────────────────────────────────────
// Everyone is charged MYR — the base prices are the same for every visitor, cached
// under one key. Country comes from a CDN header (or the `?country=` override for
// local dev/QA) and only picks the approximate local-currency estimate (fx.ts).
const pricingCache = createPricingCache<PricingPayload>({ ttlMs: 5 * 60_000, now: () => Date.now() })

app.get('/api/pricing', async (c) => {
  const country = detectCountry({
    explicitCountry: c.req.query('country') || undefined,
    getHeader: (name) => c.req.header(name),
  })
  try {
    // Base MYR prices are the same for everyone → cached under one key; the estimate
    // is a cheap pure lookup that varies by country, so it is not cached.
    const base = await pricingCache.get('base', () =>
      fetchBasePricing({
        prices: env.prices,
        retrievePrice: (id) =>
          stripe.prices
            .retrieve(id)
            .then((p) => ({ unit_amount: p.unit_amount, currency: p.currency })),
      }),
    )
    return c.json({ ...base, estimate: estimateFor(country) })
  } catch (err) {
    console.error('Pricing resolution failed:', err instanceof Error ? err.message : String(err))
    return c.json({ error: 'Pricing unavailable' }, 502)
  }
})

// ── Superadmin reads ──────────────────────────────────────────────────────────
app.get('/api/merchants', requireSuperadmin, async (c) => {
  const { data, error } = await admin
    .from('merchants').select('*').order('created_at', { ascending: false })
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json(data ?? [])
})

app.get('/api/billing', requireSuperadmin, async (c) => {
  const { data, error } = await admin.from('merchant_billing').select('*')
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json(data ?? [])
})

// ── Merchant creation (any authenticated user creates their own shop) ──────────
// The insert goes through `admin` (service_role), which bypasses guard_merchant_status —
// so `status: 'pending'`, `owner_id: user.id` and `billing_region: 'MY'` are forced here,
// never read from the body. Only name/plan/billing/referredByCode are accepted from the
// client (Global Constraint 1). Slug uniqueness resolution moved server-side now that the
// browser can no longer SELECT merchants.slug directly.
app.post('/api/merchants', requireUser, async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => ({} as any))
  const name = String(body?.name ?? '').trim()
  if (!name) return c.json({ error: 'Missing name' }, 400)

  const { data: rows } = await admin.from('merchants').select('slug')
  const slug = await resolveSlug(name, { taken: (rows ?? []).map((r) => r.slug), id: user.id })

  const { data, error } = await admin
    .from('merchants')
    .insert({
      name,
      slug,
      order_prefix: orderPrefix(slug),
      owner_id: user.id,
      status: 'pending',
      plan: body?.plan ?? 'basic',
      billing_cycle: body?.billing ?? 'monthly',
      billing_region: 'MY', // everyone is charged MYR
      referred_by_code: resolveReferredByCode(body?.referredByCode, referralCodeOf(user.id)),
    })
    .select()
    .single()
  if (error) return c.json({ error: 'Create failed' }, 500)
  return c.json(data)
})

// Owner-editable shop config. The update goes through `admin` (service_role), which bypasses
// guard_merchant_status — so `pickMerchantConfig` is the ONLY thing stopping an owner from
// self-activating a suspended shop (or reassigning owner_id) via a crafted body. See
// writes.ts and Global Constraint 1.
app.patch('/api/merchants/:id', requireMerchantOwns, async (c) => {
  const id = c.req.param('id')
  const picked = pickMerchantConfig(await c.req.json().catch(() => ({})))
  if (!picked.ok) return c.json({ error: picked.error }, 400)
  const patch = picked.patch
  if (Object.keys(patch).length === 0) return c.json({ error: 'No updatable fields' }, 400)
  const { data, error } = await admin.from('merchants').update(patch).eq('id', id).select().single()
  if (error) return c.json({ error: 'Update failed' }, 500)
  return c.json(data)
})

// Slug rename. Uniqueness resolution moves here now that the browser can no longer SELECT
// merchants.slug directly — the last browser read of merchants.
app.patch('/api/merchants/:id/slug', requireMerchantOwns, async (c) => {
  const id = c.req.param('id')
  const s = String((await c.req.json().catch(() => ({}))).slug ?? '').trim().toLowerCase()
  if (!s || RESERVED_SLUGS.includes(s)) return c.json({ error: 'Reserved or empty slug' }, 400)
  const { data: existing } = await admin.from('merchants').select('id').eq('slug', s).maybeSingle()
  if (existing && existing.id !== id) return c.json({ error: 'Slug already taken' }, 409)
  const { data, error } = await admin.from('merchants').update({ slug: s }).eq('id', id).select().single()
  if (error) return c.json({ error: 'Update failed' }, 500)
  return c.json(data)
})

// ── Owner-scoped reads (tenant enforced by requireMerchantOwns) ────────────────
app.get('/api/merchants/:id/orders', requireMerchantOwns, async (c) => {
  const m = c.get('merchant')
  const { data, error } = await admin
    .from('orders').select('*').eq('merchant_id', m.id).order('created_at', { ascending: false })
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json(data ?? [])
})

app.get('/api/merchants/:id/orders/count', requireMerchantOwns, async (c) => {
  const m = c.get('merchant')
  const { count, error } = await admin
    .from('orders').select('id', { count: 'exact', head: true }).eq('merchant_id', m.id)
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json({ count: count ?? 0 })
})

app.get('/api/merchants/:id/vouchers', requireMerchantOwns, async (c) => {
  const m = c.get('merchant')
  const { data, error } = await admin.from('vouchers').select('*').eq('merchant_id', m.id)
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json(data ?? [])
})

app.get('/api/merchants/:id/billing', requireMerchantOwns, async (c) => {
  const m = c.get('merchant')
  const { data, error } = await admin
    .from('merchant_billing').select('*').eq('merchant_id', m.id).maybeSingle()
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json(data ?? null)
})

app.get('/api/merchants/:id/secret', requireMerchantOwns, async (c) => {
  const m = c.get('merchant')
  const { data, error } = await admin
    .from('merchant_secrets').select('tg_token, tg_chat_id').eq('merchant_id', m.id).maybeSingle()
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json(data ?? null)
})

// Secret upsert. The write goes through `admin` (service_role), which bypasses RLS and the
// restricted grants on merchant_secrets — so picking only tg_token/tg_chat_id off the body is
// the ONLY guard (Global Constraint 1). merchant_id is FORCED from :id, never read from the
// body, AND is the upsert's conflict target (merchant_secrets.merchant_id is the primary key —
// see 20260627120150_secure_merchant_secrets.sql), so the product-PUT hijack class (Global
// Constraint 2) does not apply here: there is no client-supplied child id to nest a foreign
// row under. No separate tenancy check is needed.
app.put('/api/merchants/:id/secret', requireMerchantOwns, async (c) => {
  const id = c.req.param('id')
  const b = await c.req.json().catch(() => ({}) as any)
  const row: Record<string, unknown> = { merchant_id: id }
  if (b?.tg_token !== undefined) row.tg_token = b.tg_token
  if (b?.tg_chat_id !== undefined) row.tg_chat_id = b.tg_chat_id
  const { error } = await admin.from('merchant_secrets').upsert(row)
  if (error) return c.json({ error: 'Upsert failed' }, 500)
  return c.json({ ok: true })
})

// ── User-scoped reads ─────────────────────────────────────────────────────────
app.get('/api/me/profile', requireUser, async (c) => {
  const user = c.get('user')
  const { data } = await admin
    .from('profiles')
    .select('id, name, email, app_role, merchant_id, whatsapp, delivery_address')
    .eq('user_id', user.id).is('merchant_id', null).maybeSingle()
  return c.json(data ?? null)
})

// Upsert the caller's GLOBAL profile (merchant_id IS NULL). The partial unique index
// (user_id WHERE merchant_id IS NULL) can't be an ON CONFLICT target, so this mirrors the old
// browser-side select-then-insert/update. Goes through `admin` (service_role), which BYPASSES
// guard_profile_privileges — so pickProfileFields + forcing user_id/merchant_id here is the
// ONLY guard against a caller granting themselves app_role or attaching to another merchant
// (Global Constraint 1). Never read user_id/merchant_id from the body.
app.put('/api/me/profile', requireUser, async (c) => {
  const user = c.get('user')
  const fields = pickProfileFields(await c.req.json().catch(() => ({})))
  const { data: existing } = await admin
    .from('profiles').select('id').eq('user_id', user.id).is('merchant_id', null).maybeSingle()
  if (existing) {
    const { error } = await admin.from('profiles').update(fields).eq('id', existing.id)
    if (error) return c.json({ error: 'Update failed' }, 500)
  } else {
    const { error } = await admin.from('profiles').insert({
      ...fields,
      user_id: user.id,
      email: fields.email ?? user.email,
      created_at: new Date().toISOString(),
    })
    if (error) return c.json({ error: 'Insert failed' }, 500)
  }
  return c.json({ ok: true })
})

app.get('/api/me/merchant', requireUser, async (c) => {
  const user = c.get('user')
  const { data } = await admin.from('merchants').select('*').eq('owner_id', user.id).maybeSingle()
  return c.json(data ?? null)
})

// Any signed-in customer's own history at a shop. NOT requireMerchantOwns — the uid filter,
// not merchant ownership, is what scopes it. A guest (no token) is 401 and has no history.
app.get('/api/merchants/:id/my-orders', requireUser, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const { data, error } = await admin
    .from('orders').select('*')
    .eq('merchant_id', id).eq('user_id', user.id)
    .order('created_at', { ascending: false }).limit(ORDER_HISTORY_LIMIT)
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json(data ?? [])
})

// ── Public reads (no auth — storefront) ───────────────────────────────────────
// Shaped: strip internal columns before returning to an unauthenticated caller.
app.get('/api/merchants/:slug', async (c) => {
  const s = (c.req.param('slug') || '').trim().toLowerCase()
  if (!s) return c.json(null)
  const { data, error } = await admin.from('merchants').select('*').eq('slug', s).maybeSingle()
  if (error || !data) return c.json(null)
  const { owner_id: _owner_id, referred_by_code: _referred_by_code, ...pub } = data
  return c.json(pub)
})

app.get('/api/merchants/:id/products', async (c) => {
  const id = c.req.param('id')
  const { data, error } = await admin
    .from('products').select('*').eq('merchant_id', id)
    .order('sort', { ascending: true }).order('created_at', { ascending: true })
  // A 5xx here is the client's "could not ask" signal — do NOT return [] on error.
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json(data ?? [])
})

// Product upsert. The write goes through `admin` (service_role), so pickProductFields is the
// ONLY guard against a crafted body writing merchant_id (forced to :id here, never read from
// the body) or promo_sold (see writes.ts — the trigger that pins it for other roles does not
// run for service_role).
// requireMerchantOwns only proves the caller owns :id — it says nothing about productId, so an
// owner of shop A could otherwise take over shop B's product by nesting it under :id = A: .upsert()
// conflict-resolves on the primary key, so if a row with that id already exists it gets UPDATEd
// in place (including merchant_id reassigned to A) instead of a new row being inserted. Loading
// the product and checking merchant_id === :id before upserting is what closes that hole
// (Global Constraint 2), mirroring the DELETE handler below.
app.put('/api/merchants/:id/products/:productId', requireMerchantOwns, async (c) => {
  const id = c.req.param('id')
  const productId = c.req.param('productId')
  const { data: existing } = await admin.from('products').select('merchant_id').eq('id', productId).maybeSingle()
  if (existing && existing.merchant_id !== id) return c.json({ error: 'Not found' }, 404)
  const row = { ...pickProductFields(await c.req.json().catch(() => ({}))), id: productId, merchant_id: id }
  const { data, error } = await admin.from('products').upsert(row).select().single()
  if (error) return c.json({ error: 'Upsert failed' }, 500)
  return c.json(data)
})

// Product delete. requireMerchantOwns only proves the caller owns :id — it says nothing about
// productId, so an owner of shop A could otherwise delete shop B's product by nesting it under
// :id = A. Loading the product and checking merchant_id === :id before deleting is what closes
// that hole (Global Constraint 2).
app.delete('/api/merchants/:id/products/:productId', requireMerchantOwns, async (c) => {
  const id = c.req.param('id')
  const productId = c.req.param('productId')
  const { data: existing } = await admin.from('products').select('merchant_id').eq('id', productId).maybeSingle()
  if (!existing || existing.merchant_id !== id) return c.json({ error: 'Not found' }, 404)
  const { error } = await admin.from('products').delete().eq('id', productId)
  if (error) return c.json({ error: 'Delete failed' }, 500)
  return c.json({ ok: true })
})

app.get('/api/merchants/:id/vouchers/:code', async (c) => {
  const id = c.req.param('id')
  const code = c.req.param('code')
  const { data, error } = await admin
    .from('vouchers').select('*').eq('merchant_id', id).eq('code', code).maybeSingle()
  // Same contract: 5xx = could-not-ask; 200 null = shop has no such voucher.
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json(data ?? null)
})

// Voucher create. The insert goes through `admin` (service_role), so forcing merchant_id
// from :id (never read from the body) is what stops a crafted body from creating a voucher
// under someone else's shop. This is an INSERT, not an upsert, so the product-PUT hijack
// class (conflict-resolving onto a stranger's row) does not apply here — there is no
// client-supplied id to collide on. `code` is uppercased/trimmed server-side, matching the
// old client-side `input.code.trim().toUpperCase()`.
app.post('/api/merchants/:id/vouchers', requireMerchantOwns, async (c) => {
  const id = c.req.param('id')
  const b = await c.req.json().catch(() => ({} as any))
  const code = String(b?.code ?? '').trim().toUpperCase()
  if (!code) return c.json({ error: 'Missing code' }, 400)
  const { data, error } = await admin.from('vouchers').insert({
    merchant_id: id,
    code,
    kind: b?.kind,
    amount: b?.amount,
    max_uses: b?.maxUses ?? null,
  }).select().single()
  if (error) return c.json({ error: 'Create failed' }, 500)
  return c.json(data)
})

// Voucher delete. requireMerchantOwns only proves the caller owns :id — it says nothing
// about voucherId, so an owner of shop A could otherwise delete shop B's voucher by nesting
// it under :id = A. Loading the voucher and checking merchant_id === :id before deleting is
// what closes that hole (Global Constraint 2), mirroring the product DELETE handler above.
app.delete('/api/merchants/:id/vouchers/:voucherId', requireMerchantOwns, async (c) => {
  const id = c.req.param('id')
  const voucherId = c.req.param('voucherId')
  const { data: existing } = await admin.from('vouchers').select('merchant_id').eq('id', voucherId).maybeSingle()
  if (!existing || existing.merchant_id !== id) return c.json({ error: 'Not found' }, 404)
  const { error } = await admin.from('vouchers').delete().eq('id', voucherId)
  if (error) return c.json({ error: 'Delete failed' }, 500)
  return c.json({ ok: true })
})

// Order patch (status/note/tracking). The update goes through `admin` (service_role), so
// pickOrderFields is the ONLY guard against a crafted body writing e.g. total/user_id/
// order_number (Global Constraint 1) — status is additionally re-validated against
// ORDER_STATUSES here since the client-side check in store.ts is not a security boundary.
// requireMerchantOwns only proves the caller owns :id — it says nothing about orderId, so an
// owner of shop A could otherwise patch shop B's order by nesting it under :id = A. Loading the
// order and checking merchant_id === :id before updating is what closes that hole (Global
// Constraint 2), mirroring the product/voucher handlers above.
app.patch('/api/merchants/:id/orders/:orderId', requireMerchantOwns, async (c) => {
  const id = c.req.param('id')
  const orderId = c.req.param('orderId')
  const patch = pickOrderFields(await c.req.json().catch(() => ({})))
  if ('status' in patch && !ORDER_STATUSES.includes(patch.status as string)) {
    return c.json({ error: 'Invalid status' }, 400)
  }
  if (Object.keys(patch).length === 0) return c.json({ error: 'No updatable fields' }, 400)
  const { data: existing } = await admin.from('orders').select('merchant_id').eq('id', orderId).maybeSingle()
  if (!existing || existing.merchant_id !== id) return c.json({ error: 'Not found' }, 404)
  const { data, error } = await admin.from('orders').update(patch).eq('id', orderId).select().single()
  if (error) return c.json({ error: 'Update failed' }, 500)
  return c.json(data)
})

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

  const metadata = { merchant_id: merchant.id, plan, billing, region: 'MY' }
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceFor(plan, billing), quantity: 1 }],
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
app.post('/api/admin/approve-merchant', requireSuperadmin, async (c) => {
  const { merchantId } = await c.req.json().catch(() => ({}))
  if (!merchantId) return c.json({ error: 'Missing merchantId' }, 400)

  // These reads are independent — the target merchant + its billing load in parallel.
  // merchant_billing keys on the merchants PK, so both use merchantId directly. Run them
  // concurrently to save cross-network round-trips (Railway → Supabase); requireSuperadmin
  // has already gated the caller before this handler runs.
  const [merchantRes, billingRes] = await Promise.all([
    admin
      .from('merchants')
      .select('id, name, status, plan, billing_cycle, owner_id')
      .eq('id', merchantId)
      .maybeSingle(),
    admin.from('merchant_billing').select('*').eq('merchant_id', merchantId).maybeSingle(),
  ])

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
      items: [{ price: priceFor(plan, cycle) }],
      trial_period_days: 7,
      trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
      metadata: { merchant_id: merchant.id, plan, billing: cycle, region: 'MY' },
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
app.post('/api/admin/set-merchant-status', requireSuperadmin, async (c) => {
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
app.post('/api/admin/comp-merchant', requireSuperadmin, async (c) => {
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

// The quote endpoint SPENDS MONEY per cache miss (see docs/adr/0001), so it is bounded twice
// over, and the two bounds guard different things:
//
//   * `quoteIpWindow` bounds REQUESTS by caller IP — cheap flood protection, applied to hits
//     and misses alike.
//   * `quoteMerchantWindow` bounds PROVIDER CALLS per shop per day — the runaway stop. It is
//     checked only when the cache missed, because a cache hit costs nothing and must never eat
//     a shop's ceiling.
//
// Both inherit the in-memory limiter's known weaknesses KNOWINGLY, exactly as customer signup
// does: they reset on redeploy and stop protecting anything past one backend instance. Fixing
// that is its own piece of work (#101 Out of Scope).
const quoteIpWindow = createSlidingWindow({ limit: 60, windowMs: 60 * 60_000, now: () => Date.now() })
const quoteMerchantWindow = createSlidingWindow({ limit: 500, windowMs: 24 * 60 * 60_000, now: () => Date.now() })

// Bounds the Places proxy by caller IP. BOTH routes draw on this one bucket.
//
// 300/hour, deliberately five times `quoteIpWindow` above, because the two endpoints are called
// nothing alike: a quote happens ONCE per address the customer selects, while suggest fires per
// burst of typing — one address entry is realistically four to eight suggests plus one detail.
// At 60 this would be about six address entries per hour per IP, and behind carrier-grade NAT or
// a mall's wifi (most Malaysian mobile traffic, and this is a Malaysian platform) dozens of
// unrelated customers share one address. They would exhaust it in minutes, and the failure is
// silent and fatal: the address box returns nothing and the customer cannot place a delivery
// order at all.
//
// Raising a REQUEST ceiling does not raise the bill proportionally, because the billable unit is
// the SESSION: a burst of keystrokes carrying one session token, ending in a details call, bills
// as one lookup. Same in-memory limiter weaknesses as everything else here, inherited knowingly.
const placesIpWindow = createSlidingWindow({ limit: 300, windowMs: 60 * 60_000, now: () => Date.now() })

/** The caller's IP, from the proxy headers with the socket as the local-dev fallback. */
function ipOf(c: { req: { header: (n: string) => string | undefined }; env: unknown }): string {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming
  return clientIp(
    { 'x-forwarded-for': c.req.header('x-forwarded-for'), 'cf-connecting-ip': c.req.header('cf-connecting-ip') },
    incoming?.socket?.remoteAddress,
  )
}

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

// The referral rewards this member has earned. Same JWT-derived scoping as /shops — the
// caller's merchant comes from the verified token, never the request.
app.get('/api/referrals/rewards', async (c) => {
  const token = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '')
  const user = await getUserFromToken(token)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  return c.json(await listEarnedRewards(user.id))
})

// ── Merchant platform feedback (#89) ────────────────────────────────────────────
// Per-user, not per-IP: the route is authenticated, so the user id is the real actor and
// is not spoofable behind a shared NAT the way an IP is. The check runs BEFORE validation
// so a script cannot hammer the write path with malformed bodies for free; a merchant
// cannot realistically hit twenty submissions an hour by accident, and the form enforces
// both rules client-side, so a 400 arriving here is already the abnormal case.
const feedbackWindow = createSlidingWindow({ limit: 20, windowMs: 60 * 60_000, now: () => Date.now() })

app.post('/api/merchants/:id/feedback', requireMerchantOwns, async (c) => {
  const user = c.get('user')
  const merchant = c.get('merchant')

  if (!feedbackWindow.allow(user.id)) {
    return c.json({ error: 'Too many feedback submissions. Please try again later.' }, 429)
  }

  const parsed = validateFeedback(await c.req.json().catch(() => ({})))
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)

  // merchant.id comes from the route the middleware already verified; user.id from the
  // JWT. Neither is ever read from the body — see tests/api/feedback.test.ts.
  const row = await insertFeedback({ merchantId: merchant.id, userId: user.id, draft: parsed.value })
  return c.json(row, 201)
})

app.get('/api/admin/feedback', requireSuperadmin, async (c) => {
  const status = c.req.query('status')
  if (status !== undefined && !isFeedbackStatus(status)) {
    return c.json({ error: 'Unknown feedback status' }, 400)
  }
  return c.json(await listFeedback(status))
})

app.patch('/api/admin/feedback/:feedbackId', requireSuperadmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { status?: unknown }
  if (!isFeedbackStatus(body.status)) return c.json({ error: 'Unknown feedback status' }, 400)

  const row = await updateFeedbackStatus(c.req.param('feedbackId'), body.status)
  if (!row) return c.json({ error: 'Feedback not found' }, 404)
  return c.json(row)
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

  // A cart is ids → positive whole quantities, within the caps — `isCart` from @bitetime/shared
  // is the rule, and it is shared for the same reason the pricing is: the storefront stops the
  // customer AT those caps, so the UI cannot build a cart this door then refuses. A local copy
  // of the numbers here is a copy that can drift, and a drifted cap is a dead checkout — the
  // customer sees `invalid_body` with nothing to do about it.
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

  // A string or nothing. The SHAPE is checked here; whether the shop is actually taking that
  // date is `placeOrder`'s call, because the window is the shop's rule and not HTTP's — the
  // same split as `mode` (allowlisted here) versus the delivery region (refused there).
  const fulfilDate = typeof b.fulfilDate === 'string' ? b.fulfilDate : null

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
      // The voucher's one-per-customer key. From the token, exactly like `userId`, and for
      // exactly the same reason: a body-supplied key is one the customer can simply change.
      userEmail: user?.email ?? null,
      customerName: b.customerName,
      customerWa: b.customerWa,
      mode,
      address: b.address ?? null,
      cart: b.cart,
      quotedTotal,
      voucherCode: typeof b.voucherCode === 'string' ? b.voucherCode : null,
      fulfilDate,
      // Lifted off the ADDRESS, not a sibling body field: it is a property of where the parcel
      // goes, and keeping the two together is what stops an address and a place id from
      // disagreeing. The distance itself is never read from the body — see placeOrder.
      destinationPlaceId: typeof (b.address as Record<string, unknown> | null)?.place_id === 'string'
        ? ((b.address as Record<string, unknown>).place_id as string)
        : null,
    })
    return c.json(result)
  } catch (err) {
    // A refusal the customer can act on — a closed shop, a spent voucher, a price that moved —
    // carries its code so the storefront can say which, and can offer the right retry. Anything
    // else is a bug, and must not be dressed up as a domain error the customer can "fix".
    if (err instanceof OrderError) {
      // `price_changed` carries the server's own clock alongside the refusal. This is what
      // actually closes the recovery loop (see /api/time above and serverClock.ts): a browser
      // whose sync fetch is persistently unreachable can still recover here, because the SAME
      // response that refuses the order also timestamps itself — no second endpoint to fail.
      // Scoped to this one code (not every OrderError) so the exact-body assertions the other
      // refusals already have in tests/api stay exact.
      const body: Record<string, unknown> = { error: err.code }
      if (err.code === 'price_changed') body.now = new Date().toISOString()
      return c.json(body, err.code === 'merchant_not_found' ? 404 : 409)
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

// ── Distance delivery quote ───────────────────────────────────────────────────
// Unauthenticated on purpose: a guest checkout must be able to see its delivery fee, and guest
// checkout is a first-class path.
//
// It takes a PLACE ID rather than an address, and that is an API-shape decision with a cost
// behind it: a free-text field invites a caller to mint unlimited distinct destinations, and
// every distinct destination is a billable lookup on the platform's own Maps account. Note the
// shape is the deterrent, not a validation — any non-empty string is accepted, because place ids
// have no stable public format and a shape check would refuse legitimate addresses. What
// actually bounds the spend is the pair of limits below. (docs/adr/0001)
//
// A hit on `distance_quotes` is the normal case and costs nothing; the same row is what order
// intake reads a moment later, which is what makes the quote and the charge the same number.
app.post('/api/shipping/quote', async (c) => {
  const body = await c.req.json().catch(() => null)
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b.merchantId !== 'string' || !b.merchantId || typeof b.placeId !== 'string' || !b.placeId) {
    return c.json({ error: 'invalid_body' }, 400)
  }

  if (!quoteIpWindow.allow(ipOf(c))) return c.json({ error: 'rate_limited' }, 429)

  const { data: merchant } = await admin
    .from('merchants')
    .select('id, currency, status, shipping_mode, delivery_base_fee, delivery_rate_per_km, delivery_max_km, origin_place_id')
    .eq('id', b.merchantId)
    .maybeSingle()
  if (!merchant) return c.json({ error: 'merchant_not_found' }, 404)
  if (merchant.status !== 'active') return c.json({ error: 'merchant_inactive' }, 409)

  // `shopDistance`, not a local read of these columns: the storefront quotes from this exact
  // function and order intake charges from it, and a third reading here is a third rule the
  // customer meets as a `price_changed` refusal.
  const policy = shopDistance(merchant)
  if (policy.mode !== 'distance' || !policy.usable) return c.json({ error: 'not_distance_priced' }, 409)

  // The ceiling is checked against PROVIDER CALLS, so a cache hit is free. Peek at the cache
  // first for exactly that reason.
  //
  // A cache read that throws degrades to a MISS, exactly as `resolveDistance` does with its own
  // read. The peek exists only to decide whether this request should cost the shop a slot of its
  // daily ceiling, so a database blip must not turn a quotable address into a 500 — it just means
  // this one is metered like any other miss.
  let cached: number | null = null
  try {
    cached = await liveDistanceDeps.readCache(
      policy.originPlaceId!, b.placeId, new Date(Date.now() - CACHE_TTL_MS),
    )
  } catch (err) {
    console.error('Distance cache peek failed:', err instanceof Error ? err.message : String(err))
  }
  if (cached === null && !quoteMerchantWindow.allow(merchant.id)) {
    return c.json({ error: 'quota_exceeded' }, 429)
  }

  const outcome = cached !== null
    ? ({ status: 'ok', metres: cached } as const)
    : await resolveDistance(liveDistanceDeps, {
        originPlaceId: policy.originPlaceId!,
        destinationPlaceId: b.placeId,
      })

  // NO ROUTE AND OUT-OF-RANGE ARE THE SAME ANSWER to the customer — "this shop does not deliver
  // there" — because they are the same fact. Only `failed` invites a retry.
  if (outcome.status === 'no_route') return c.json({ error: 'out_of_range' }, 409)
  if (outcome.status === 'failed') return c.json({ error: 'lookup_failed' }, 409)

  const km = routedKm(outcome.metres)
  if (exceedsMaxKm(policy, km)) return c.json({ error: 'out_of_range' }, 409)

  return c.json({ km, fee: distanceFee(policy, km), currency: merchant.currency ?? 'MYR' })
})

// ── Address autocomplete proxy ────────────────────────────────────────────────
// Proxied for ONE reason above all: the Maps credential must never reach the browser, where a
// key can be lifted off a page and spent elsewhere (#101, story 49).
//
// `session` is money, not hygiene: a burst of keystrokes carrying one token bills as a single
// lookup when it ends in a details call. The browser mints it and passes the SAME one to
// /api/places/detail.
//
// Unauthenticated, because a guest picking a delivery address has no session. Bounded by IP for
// the same reason the quote endpoint is: these calls cost the platform money.
app.get('/api/places/suggest', async (c) => {
  if (!placesIpWindow.allow(ipOf(c))) return c.json({ error: 'rate_limited' }, 429)
  const input = c.req.query('input') ?? ''
  const session = c.req.query('session') ?? ''
  // A short prefix is noise that still bills. Empty results, no call.
  if (input.trim().length < 3) return c.json({ suggestions: [] })
  return c.json({ suggestions: await googlePlaceSuggest(input, session) })
})

app.get('/api/places/detail/:placeId', async (c) => {
  if (!placesIpWindow.allow(ipOf(c))) return c.json({ error: 'rate_limited' }, 429)
  const detail = await googlePlaceDetail(c.req.param('placeId'), c.req.query('session') ?? '')
  if (!detail) return c.json({ error: 'place_not_found' }, 404)
  return c.json(detail)
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
      case 'invoice.paid': {
        const inv = event.data.object
        // The referred merchant's FIRST real payment is the referral-reward trigger.
        // `amount_paid > 0` excludes the $0 trial-start invoice; the billing_reason
        // allowlist keeps it to a subscription's own invoices (create = paid signup /
        // reactivation, cycle = trial converting or renewing). The reward is granted at
        // most once per referred shop (referral_rewards PK), so a later renewal cycle
        // finds the row and no-ops — only the first qualifying paid invoice pays out.
        const reason = (inv as { billing_reason?: string }).billing_reason
        const firstPaid =
          (inv.amount_paid ?? 0) > 0 &&
          (reason === 'subscription_create' || reason === 'subscription_cycle')
        if (!firstPaid) break

        // Same metadata drift-hardening as invoice.payment_failed above.
        const parent = (inv as { parent?: { subscription_details?: { metadata?: Record<string, string> } } }).parent
        const merchantId =
          (inv as { subscription_details?: { metadata?: Record<string, string> } }).subscription_details?.metadata?.merchant_id ||
          parent?.subscription_details?.metadata?.merchant_id ||
          inv.metadata?.merchant_id
        if (merchantId) {
          const decision = await processReferralReward(merchantId)
          if (!decision.grant && decision.reason !== 'not_referred' && decision.reason !== 'already_rewarded') {
            console.log(`Referral reward skipped for referred merchant ${merchantId}: ${decision.reason}`)
          }
        }
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
