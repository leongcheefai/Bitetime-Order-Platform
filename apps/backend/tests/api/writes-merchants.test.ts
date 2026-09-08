// tests/api/writes-merchants.test.ts
// POST /api/merchants — create-shop endpoint. The load-bearing assertion is that the
// handler forces status/owner_id server-side: the insert goes through `admin`
// (service_role), which BYPASSES guard_merchant_status, so if the handler ever spread a
// raw client body into .insert() a caller could self-activate their own shop or plant it
// under someone else's owner_id. See CLAUDE.md → Backend, Global Constraint 1.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { app, platformNotifyDeps } from '../../src/app.js'
import { SHOP_DESCRIPTION_MAX } from '@bitetime/shared'
import { makeUser, seedMerchant, serviceClient, resetMerchant } from '../rls/helpers.js'

async function tokenOf(client: Awaited<ReturnType<typeof makeUser>>) {
  const { data } = await client.auth.getSession()
  return { token: data.session!.access_token, userId: data.session!.user.id }
}

function post(path: string, body: unknown, token?: string) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

function patch(path: string, body: unknown, token?: string) {
  return app.request(path, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

type MerchantRow = { id: string; slug: string; status: string; owner_id: string; order_prefix: string }

describe('POST /api/merchants', () => {
  it('creates a pending shop owned by the caller with a resolved slug', async () => {
    await resetMerchant('joe-coffee')
    const client = await makeUser('create-shop@example.com', 'password123')
    const { token, userId } = await tokenOf(client)

    const res = await post('/api/merchants', { name: 'Joe Coffee', billing: 'monthly', businessNature: 'bakery' }, token)

    expect(res.status).toBe(200)
    const m = (await res.json()) as MerchantRow
    expect(m.slug).toBe('joe-coffee')
    expect(m.status).toBe('pending')
    expect(m.owner_id).toBe(userId)
    expect(m.order_prefix).toBe('JO')

    await serviceClient().from('merchants').delete().eq('id', m.id)
  })

  it('ignores a client-supplied status and owner_id (privilege guard)', async () => {
    await resetMerchant('evil-shop')
    const client = await makeUser('create-evil@example.com', 'password123')
    const { token, userId } = await tokenOf(client)

    const res = await post('/api/merchants', {
      name: 'Evil Shop',
      status: 'active',
      owner_id: '00000000-0000-0000-0000-000000000000',
      businessNature: 'bakery',
    }, token)

    expect(res.status).toBe(200)
    const m = (await res.json()) as MerchantRow
    expect(m.status).toBe('pending')
    expect(m.owner_id).toBe(userId)

    await serviceClient().from('merchants').delete().eq('id', m.id)
  })

  it('suffixes a taken slug', async () => {
    await resetMerchant('taken-name-2')
    const ownerX = await makeUser('owner-x@example.com', 'password123')
    const { userId: ownerXId } = await tokenOf(ownerX)
    const takenId = await seedMerchant({ slug: 'taken-name', owner_id: ownerXId })

    const client = await makeUser('create-dup@example.com', 'password123')
    const { token } = await tokenOf(client)

    const res = await post('/api/merchants', { name: 'Taken Name', businessNature: 'bakery' }, token)

    expect(res.status).toBe(200)
    const m = (await res.json()) as MerchantRow
    expect(m.slug).toBe('taken-name-2')

    await serviceClient().from('merchants').delete().eq('id', m.id)
    await serviceClient().from('merchants').delete().eq('id', takenId)
  })

  it('401 without a token', async () => {
    const res = await post('/api/merchants', {})
    expect(res.status).toBe(401)
  })

  // The superadmin's own Telegram alert. Every shop row produces one, including the shop Stripe
  // refused — which is the case that matters, because a `pending` shop sells nothing and nobody
  // learns of it unless someone opens /admin. The send is fire-and-forget, so the assertion
  // waits for it rather than assuming the response ordered it.
  it('tells the platform Telegram chat about the new shop', async () => {
    await resetMerchant('alert-cafe')
    const client = await makeUser('create-alert@example.com', 'password123')
    const { token } = await tokenOf(client)

    const sent: Array<[string, string, string]> = []
    const telegram = platformNotifyDeps.telegram
    const config = platformNotifyDeps.config
    platformNotifyDeps.telegram = async (t, chatId, text) => { sent.push([t, chatId, text]) }
    platformNotifyDeps.config = { token: 'platform-tok', chatId: '-100999' }

    try {
      const res = await post('/api/merchants', { name: 'Alert Cafe', businessNature: 'bakery' }, token)
      expect(res.status).toBe(200)
      const m = (await res.json()) as MerchantRow

      await vi.waitFor(() => expect(sent).toHaveLength(1))
      const [usedToken, usedChat, text] = sent[0]
      expect(usedToken).toBe('platform-tok')
      expect(usedChat).toBe('-100999')
      expect(text).toContain('Alert Cafe')
      expect(text).toContain('alert-cafe')
      expect(text).toContain('create-alert@example.com')
      // Stripe is stubbed in this config and can never authenticate, so the shop is parked.
      expect(text).toContain('pending')

      await serviceClient().from('merchants').delete().eq('id', m.id)
    } finally {
      platformNotifyDeps.telegram = telegram
      platformNotifyDeps.config = config
    }
  })

  // Signup provisions the trial itself — no approval in the path. This suite is network-free and
  // vitest.db.config.ts injects STRIPE_SECRET_KEY='sk_test_stub', which can never authenticate,
  // so the Stripe call here DETERMINISTICALLY fails. That is the contract under test: a shop is
  // still created, it is parked at `pending`, `trial` is false, and no billing row is written —
  // the merchant retries from the dashboard. The happy path needs a real key and is covered by
  // run-and-verify.
  it('keeps the shop when Stripe refuses, parked at pending with no trial', async () => {
    await resetMerchant('stripe-down-cafe')
    const client = await makeUser('stripe-down@example.com', 'password123')
    const { token } = await tokenOf(client)

    const res = await post('/api/merchants', { name: 'Stripe Down Cafe', billing: 'monthly', businessNature: 'bakery' }, token)

    expect(res.status).toBe(200)
    const m = (await res.json()) as MerchantRow & { trial: boolean }
    expect(m.trial).toBe(false)
    expect(m.status).toBe('pending')

    const { data: row } = await serviceClient()
      .from('merchants').select('status').eq('id', m.id).maybeSingle()
    expect(row!.status).toBe('pending')

    const { data: billing } = await serviceClient()
      .from('merchant_billing').select('merchant_id').eq('merchant_id', m.id).maybeSingle()
    expect(billing).toBeNull()

    await serviceClient().from('merchants').delete().eq('id', m.id)
  })

  // There is one signup path now (#222): every shop is offered the cardless trial and no body can
  // route around it. A `plan` field is a leftover from the two-tier release and must be ignored
  // rather than send this shop off to Checkout. `trial` being PRESENT is the assertion — it is
  // false here only because the stub key cannot authenticate, per the note above.
  it('attempts the trial whatever the body claims, ignoring a stale plan field', async () => {
    await resetMerchant('pro-cafe')
    const client = await makeUser('pro-signup@example.com', 'password123')
    const { token } = await tokenOf(client)

    const res = await post('/api/merchants', { name: 'Pro Cafe', plan: 'pro', billing: 'monthly', businessNature: 'bakery' }, token)

    expect(res.status).toBe(200)
    const m = (await res.json()) as MerchantRow & { trial?: boolean }
    expect(m.trial).toBe(false)
    expect(m.status).toBe('pending')

    const { data: billing } = await serviceClient()
      .from('merchant_billing').select('merchant_id').eq('merchant_id', m.id).maybeSingle()
    expect(billing).toBeNull()

    await serviceClient().from('merchants').delete().eq('id', m.id)
  })

  // #161. Read back with the service client rather than trusting the response body: the point
  // is that the column the admin Overview groups on actually holds the industry.
  it('stores the business nature the signup form collected', async () => {
    await resetMerchant('nature-shop')
    const client = await makeUser('create-nature@example.com', 'password123')
    const { token } = await tokenOf(client)

    const res = await post('/api/merchants', { name: 'Nature Shop', businessNature: 'bakery' }, token)

    expect(res.status).toBe(200)
    const m = (await res.json()) as MerchantRow
    const { data: row } = await serviceClient()
      .from('merchants').select('business_nature').eq('id', m.id).single()
    expect(row!.business_nature).toBe('bakery')

    await serviceClient().from('merchants').delete().eq('id', m.id)
  })

  // Business nature is now mandatory at signup (it is no longer editable afterwards, so an
  // absent one would leave the shop stuck with an industry nobody can ever set).
  it('400s when no business nature is sent, without creating a shop', async () => {
    await resetMerchant('natureless-shop')
    const client = await makeUser('create-natureless@example.com', 'password123')
    const { token } = await tokenOf(client)

    const res = await post('/api/merchants', { name: 'Natureless Shop' }, token)

    expect(res.status).toBe(400)
    const { data: rows } = await serviceClient()
      .from('merchants').select('id').eq('slug', 'natureless-shop')
    expect(rows ?? []).toEqual([])
  })

  it('400s on an unknown business nature rather than creating a shop without one', async () => {
    await resetMerchant('bad-nature-shop')
    const client = await makeUser('create-bad-nature@example.com', 'password123')
    const { token } = await tokenOf(client)

    const res = await post('/api/merchants', { name: 'Bad Nature Shop', businessNature: 'cake shop' }, token)

    expect(res.status).toBe(400)
    const { data: rows } = await serviceClient()
      .from('merchants').select('id').eq('slug', 'bad-nature-shop')
    expect(rows ?? []).toEqual([])
  })

  // Currency is chosen at signup and never editable afterwards (writes.ts). Read back with the
  // service client — the point is that the stored row, not just the response, holds it.
  it('stores the currency the signup form collected', async () => {
    await resetMerchant('currency-shop')
    const client = await makeUser('create-currency@example.com', 'password123')
    const { token } = await tokenOf(client)

    const res = await post('/api/merchants', { name: 'Currency Shop', businessNature: 'bakery', currency: 'SGD' }, token)

    expect(res.status).toBe(200)
    const m = (await res.json()) as MerchantRow
    const { data: row } = await serviceClient()
      .from('merchants').select('currency').eq('id', m.id).single()
    expect(row!.currency).toBe('SGD')

    await serviceClient().from('merchants').delete().eq('id', m.id)
  })

  // Unlike business nature, currency has a sane default — a caller that sends nothing gets MYR,
  // the column's own default, rather than a 400.
  it('defaults to MYR when no currency is sent', async () => {
    await resetMerchant('currencyless-shop')
    const client = await makeUser('create-currencyless@example.com', 'password123')
    const { token } = await tokenOf(client)

    const res = await post('/api/merchants', { name: 'Currencyless Shop', businessNature: 'bakery' }, token)

    expect(res.status).toBe(200)
    const m = (await res.json()) as MerchantRow
    const { data: row } = await serviceClient()
      .from('merchants').select('currency').eq('id', m.id).single()
    expect(row!.currency).toBe('MYR')

    await serviceClient().from('merchants').delete().eq('id', m.id)
  })

  it('400s on an unknown currency rather than creating a shop with one', async () => {
    await resetMerchant('bad-currency-shop')
    const client = await makeUser('create-bad-currency@example.com', 'password123')
    const { token } = await tokenOf(client)

    const res = await post('/api/merchants', { name: 'Bad Currency Shop', businessNature: 'bakery', currency: 'XXX' }, token)

    expect(res.status).toBe(400)
    const { data: rows } = await serviceClient()
      .from('merchants').select('id').eq('slug', 'bad-currency-shop')
    expect(rows ?? []).toEqual([])
  })
})

describe('PATCH /api/merchants/:id (config)', () => {
  it('updates allowlisted config for the owner', async () => {
    await resetMerchant('cfg-shop')
    const client = await makeUser('cfg-owner@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    const id = await seedMerchant({ slug: 'cfg-shop', owner_id: userId })

    const res = await patch(`/api/merchants/${id}`, { payment_note: 'Pay on pickup' }, token)

    expect(res.status).toBe(200)
    const m = (await res.json()) as { payment_note: string }
    expect(m.payment_note).toBe('Pay on pickup')

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('IGNORES status and owner_id in the body (no self-activation)', async () => {
    await resetMerchant('cfg-evil-shop')
    const client = await makeUser('cfg-evil@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    const id = await seedMerchant({ slug: 'cfg-evil-shop', owner_id: userId, status: 'suspended' })

    const res = await patch(`/api/merchants/${id}`, {
      status: 'active',
      owner_id: '00000000-0000-0000-0000-000000000000',
      payment_note: 'x',
    }, token)

    expect(res.status).toBe(200)

    // Load-bearing: read back with the service client, NOT the response body — the response
    // is what the handler returned, but the assertion that matters is what actually landed in
    // Postgres. The insert/update goes through `admin` (service_role), which bypasses
    // guard_merchant_status, so pickMerchantConfig is the ONLY thing standing between this body
    // and a self-activated suspended shop.
    const { data: row } = await serviceClient()
      .from('merchants').select('status, owner_id').eq('id', id).single()
    expect(row!.status).toBe('suspended')
    expect(row!.owner_id).toBe(userId)

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  // business_nature is signup-only now: it is set once at creation (POST /api/merchants) and
  // dropped from MERCHANT_CONFIG_FIELDS, so a PATCH naming it alone has no updatable field.
  it('ignores business_nature in a PATCH — it is set at signup and never editable after', async () => {
    await resetMerchant('cfg-nature-shop')
    const client = await makeUser('cfg-nature@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    const id = await seedMerchant({ slug: 'cfg-nature-shop', owner_id: userId })

    const res = await patch(`/api/merchants/${id}`, { business_nature: 'florist' }, token)
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('No updatable fields')

    const { data: row } = await serviceClient()
      .from('merchants').select('business_nature').eq('id', id).single()
    expect(row!.business_nature).toBeNull()

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  // currency is signup-only too, same reasoning: re-denominating past totals is exactly what
  // this lock exists to prevent, and that has to hold on a direct PATCH, not just in the UI.
  it('ignores currency in a PATCH — it is set at signup and never editable after', async () => {
    await resetMerchant('cfg-currency-shop')
    const client = await makeUser('cfg-currency@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    const id = await seedMerchant({ slug: 'cfg-currency-shop', owner_id: userId })

    const res = await patch(`/api/merchants/${id}`, { currency: 'SGD' }, token)
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('No updatable fields')

    const { data: row } = await serviceClient()
      .from('merchants').select('currency').eq('id', id).single()
    expect(row!.currency).toBe('MYR')

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  // #156. The QR is a Storage path, and the write goes through the service role — no policy
  // runs on it, so this endpoint is the only thing keeping a shop's row pointed at its own
  // object. A stranger's path is refused, and the stored value is left alone.
  it('saves a payment QR path in the shop\'s own folder, and refuses another shop\'s', async () => {
    await resetMerchant('cfg-qr-shop')
    const client = await makeUser('cfg-qr@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    const id = await seedMerchant({ slug: 'cfg-qr-shop', owner_id: userId })

    const ok = await patch(`/api/merchants/${id}`, { payment_qr: `${id}/duitnow.png` }, token)
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { payment_qr: string }).payment_qr).toBe(`${id}/duitnow.png`)

    const stranger = '00000000-0000-0000-0000-000000000000'
    const bad = await patch(`/api/merchants/${id}`, { payment_qr: `${stranger}/duitnow.png` }, token)
    expect(bad.status).toBe(400)

    // Clearing is legal, and is the only way back to no QR.
    const cleared = await patch(`/api/merchants/${id}`, { payment_qr: '' }, token)
    expect(cleared.status).toBe(200)

    const { data: row } = await serviceClient()
      .from('merchants').select('payment_qr').eq('id', id).single()
    expect(row!.payment_qr).toBeNull()

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('403 for a non-owner', async () => {
    await resetMerchant('cfg-a-shop')
    const owner = await makeUser('cfg-a@example.com', 'password123')
    const { userId: ownerId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'cfg-a-shop', owner_id: ownerId })

    const other = await makeUser('cfg-b@example.com', 'password123')
    const { token: otherToken } = await tokenOf(other)

    const res = await patch(`/api/merchants/${id}`, { payment_note: 'x' }, otherToken)
    expect(res.status).toBe(403)

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('400 when no updatable fields are present', async () => {
    await resetMerchant('cfg-empty-shop')
    const client = await makeUser('cfg-empty@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    const id = await seedMerchant({ slug: 'cfg-empty-shop', owner_id: userId })

    const res = await patch(`/api/merchants/${id}`, { status: 'active', owner_id: 'x' }, token)
    expect(res.status).toBe(400)

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('401 without a token', async () => {
    await resetMerchant('cfg-anon-shop')
    const client = await makeUser('cfg-anon@example.com', 'password123')
    const { userId } = await tokenOf(client)
    const id = await seedMerchant({ slug: 'cfg-anon-shop', owner_id: userId })

    const res = await patch(`/api/merchants/${id}`, { payment_note: 'x' })
    expect(res.status).toBe(401)

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  // ── Tax settings (#88) — accepted from the owner, refused (never coerced) when invalid ──
  it('accepts tax settings from the owner', async () => {
    await resetMerchant('cfg-tax-shop')
    const client = await makeUser('cfg-tax@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    const id = await seedMerchant({ slug: 'cfg-tax-shop', owner_id: userId })

    const res = await patch(`/api/merchants/${id}`, { tax_enabled: true, tax_rate: 6 }, token)

    expect(res.status).toBe(200)
    const m = (await res.json()) as { tax_enabled: boolean; tax_rate: number }
    expect(m.tax_enabled).toBe(true)
    expect(Number(m.tax_rate)).toBe(6)

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('refuses a rate outside 0-100 instead of storing it', async () => {
    await resetMerchant('cfg-tax-hi-shop')
    const client = await makeUser('cfg-tax-hi@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    const id = await seedMerchant({ slug: 'cfg-tax-hi-shop', owner_id: userId })

    const res = await patch(`/api/merchants/${id}`, { tax_rate: 150 }, token)
    expect(res.status).toBe(400)

    // Load-bearing: read back with the service client, NOT just the response status — a
    // handler that stored 150 and THEN returned 400 would still pass a status-only assertion.
    const { data: row } = await serviceClient()
      .from('merchants').select('tax_rate').eq('id', id).single()
    expect(Number(row!.tax_rate)).toBe(0)

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('refuses a non-numeric rate', async () => {
    await resetMerchant('cfg-tax-nan-shop')
    const client = await makeUser('cfg-tax-nan@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    const id = await seedMerchant({ slug: 'cfg-tax-nan-shop', owner_id: userId })

    const res = await patch(`/api/merchants/${id}`, { tax_rate: 'six' }, token)
    expect(res.status).toBe(400)

    await serviceClient().from('merchants').delete().eq('id', id)
  })
})

describe('PATCH /api/merchants/:id/slug', () => {
  it('renames when the slug is free', async () => {
    await resetMerchant('old-slug')
    await resetMerchant('new-slug')
    const client = await makeUser('slug-owner@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    const id = await seedMerchant({ slug: 'old-slug', owner_id: userId })

    const res = await patch(`/api/merchants/${id}/slug`, { slug: 'new-slug' }, token)

    expect(res.status).toBe(200)
    const m = (await res.json()) as MerchantRow
    expect(m.slug).toBe('new-slug')

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('409 when the slug is taken by another merchant', async () => {
    await resetMerchant('busy')
    await resetMerchant('mine')
    const a = await makeUser('slug-a@example.com', 'password123')
    const { userId: aId } = await tokenOf(a)
    const busyId = await seedMerchant({ slug: 'busy', owner_id: aId })

    const b = await makeUser('slug-b@example.com', 'password123')
    const { token: bToken, userId: bId } = await tokenOf(b)
    const id = await seedMerchant({ slug: 'mine', owner_id: bId })

    const res = await patch(`/api/merchants/${id}/slug`, { slug: 'busy' }, bToken)
    expect(res.status).toBe(409)

    await serviceClient().from('merchants').delete().eq('id', id)
    await serviceClient().from('merchants').delete().eq('id', busyId)
  })

  it('400 on a reserved slug', async () => {
    await resetMerchant('res-shop')
    const client = await makeUser('slug-res@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    const id = await seedMerchant({ slug: 'res-shop', owner_id: userId })

    const res = await patch(`/api/merchants/${id}/slug`, { slug: 'admin' }, token)
    expect(res.status).toBe(400)

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('403 for a non-owner', async () => {
    await resetMerchant('slug-a-shop')
    const owner = await makeUser('slug-owner2@example.com', 'password123')
    const { userId: ownerId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'slug-a-shop', owner_id: ownerId })

    const other = await makeUser('slug-owner2-b@example.com', 'password123')
    const { token: otherToken } = await tokenOf(other)

    const res = await patch(`/api/merchants/${id}/slug`, { slug: 'whatever' }, otherToken)
    expect(res.status).toBe(403)

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('401 without a token', async () => {
    await resetMerchant('slug-anon-shop')
    const client = await makeUser('slug-anon@example.com', 'password123')
    const { userId } = await tokenOf(client)
    const id = await seedMerchant({ slug: 'slug-anon-shop', owner_id: userId })

    const res = await patch(`/api/merchants/${id}/slug`, { slug: 'whatever' })
    expect(res.status).toBe(401)

    await serviceClient().from('merchants').delete().eq('id', id)
  })
})

// ── Fulfilment methods (#103) ────────────────────────────────────────────────────
// One shop, re-seeded before every test so each case starts from the column defaults
// (pickup + delivery on, express off, no origin) regardless of what a prior case saved.
describe('PATCH /api/merchants/:id (shipping policy)', () => {
  let merchantId: string
  let ownerToken: string

  beforeEach(async () => {
    await resetMerchant('cfg-shipping-shop')
    const client = await makeUser('cfg-shipping@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    merchantId = await seedMerchant({ slug: 'cfg-shipping-shop', owner_id: userId })
    ownerToken = token
  })

  function patchMerchant(id: string, token: string, body: unknown) {
    return patch(`/api/merchants/${id}`, body, token)
  }

  describe('shipping policy fields', () => {
    it('saves a complete distance policy', async () => {
      const res = await patchMerchant(merchantId, ownerToken, {
        express_enabled: true,
        delivery_base_fee: 6,
        delivery_rate_per_km: 1,
        delivery_max_km: 30,
        origin_place_id: 'ChIJorigin',
        origin_lat: 3.139003,
        origin_lng: 101.686855,
        origin_address: '12 Jalan Example, 50000 Kuala Lumpur',
      })
      expect(res.status).toBe(200)
    })

    it('refuses a negative base fee, rate or maximum — a typo must not make a delivery pay the customer', async () => {
      for (const patchBody of [{ delivery_base_fee: -1 }, { delivery_rate_per_km: -0.5 }, { delivery_max_km: -3 }]) {
        const res = await patchMerchant(merchantId, ownerToken, patchBody)
        expect(res.status).toBe(400)
      }
    })

    it('refuses a blank/whitespace string in a numeric field instead of coercing it to 0', async () => {
      // Number('') and Number('   ') are both 0 — the same trap tax_rate already guards against.
      // A caller that clears a numeric field and sends '' must not silently save a 0 fee.
      for (const patchBody of [{ delivery_base_fee: '' }, { delivery_rate_per_km: '   ' }, { delivery_max_km: '' }]) {
        const res = await patchMerchant(merchantId, ownerToken, patchBody)
        expect(res.status).toBe(400)
      }
    })

    it('refuses a maximum of zero, which is not "no limit"', async () => {
      const res = await patchMerchant(merchantId, ownerToken, { delivery_max_km: 0 })
      expect(res.status).toBe(400)
    })

    it('accepts a null maximum as "deliver anywhere with a road"', async () => {
      const res = await patchMerchant(merchantId, ownerToken, { delivery_max_km: null })
      expect(res.status).toBe(200)
    })

    it('refuses switching express on with no origin set', async () => {
      // Story 5: a merchant must not be able to half-configure their shop into quoting nothing.
      await patchMerchant(merchantId, ownerToken, { origin_place_id: null, express_enabled: false })
      const res = await patchMerchant(merchantId, ownerToken, { express_enabled: true })
      expect(res.status).toBe(400)
    })

    it('refuses switching express on when the patch explicitly nulls the origin in the same save', async () => {
      // The check must see the patch's own value, not just the row's stored origin. If a check
      // only reads the row's value and ignores the patch's explicit null, a rewritten code path
      // like `patch.origin_place_id ?? row.origin` would wrongly allow switching express on
      // with an explicit null. This test catches that regression: first give the shop a real
      // origin, then try to null it and switch express on in the same save — the explicit null wins.
      const setupRes = await patchMerchant(merchantId, ownerToken, {
        express_enabled: false,
        origin_place_id: 'ChIJorigin',
      })
      expect(setupRes.status).toBe(200)
      const res = await patchMerchant(merchantId, ownerToken, {
        express_enabled: true,
        origin_place_id: null,
      })
      expect(res.status).toBe(400)
    })

    it('allows switching express on using an origin saved in an EARLIER save, without resending it', async () => {
      // The other half of "the check has to see the row's CURRENT origin as well as the
      // patch's": a merchant who sets their origin in one save and flips express on in a LATER
      // save (never resending origin_place_id) must succeed — a check that only reads the
      // patch's own value, and never falls back to the row, would wrongly refuse this.
      await patchMerchant(merchantId, ownerToken, { origin_place_id: 'ChIJorigin', express_enabled: false })
      const res = await patchMerchant(merchantId, ownerToken, { express_enabled: true })
      expect(res.status).toBe(200)
    })

    it('does not block an express shop from saving unrelated fields', async () => {
      // A merchant already offering express with an origin set must be able to save something
      // that has nothing to do with shipping (e.g. a payment note) without tripping the origin
      // check — it must only fire when the patch is actually TURNING ON express.
      const setupRes = await patchMerchant(merchantId, ownerToken, {
        express_enabled: true,
        origin_place_id: 'ChIJorigin',
      })
      expect(setupRes.status).toBe(200)
      const res = await patchMerchant(merchantId, ownerToken, { payment_note: 'Ring the bell twice' })
      expect(res.status).toBe(200)
    })
  })

  describe('at least one fulfilment method', () => {
    it('refuses a save that would leave the shop offering nothing', async () => {
      // Default seed is pickup + delivery on, express off. Clearing both in one body leaves
      // nothing on — refused before the DB CHECK ever answers with a bare 500.
      const res = await patchMerchant(merchantId, ownerToken, { pickup_enabled: false, delivery_enabled: false })
      expect(res.status).toBe(400)
      expect(((await res.json()) as any).error).toMatch(/at least one fulfilment method/)
    })

    it('judges the LAST flag against the stored row, not against the patch alone', async () => {
      // The trap this check exists for. Two saves, each legal on its own body: the first turns
      // delivery off (pickup still on, fine), the second turns pickup off. Reading only the
      // second patch sees one false flag and waves it through — and the shop is left with no
      // method at all. The merged read is what catches it.
      const first = await patchMerchant(merchantId, ownerToken, { delivery_enabled: false })
      expect(first.status).toBe(200)
      const res = await patchMerchant(merchantId, ownerToken, { pickup_enabled: false })
      expect(res.status).toBe(400)
      expect(((await res.json()) as any).error).toMatch(/at least one fulfilment method/)
    })

    it('lets one shop offer delivery AND express at once', async () => {
      const res = await patchMerchant(merchantId, ownerToken, {
        delivery_enabled: true, express_enabled: true, origin_place_id: 'ChIJorigin',
      })
      expect(res.status).toBe(200)
      const row = (await res.json()) as any
      expect(row.delivery_enabled).toBe(true)
      expect(row.express_enabled).toBe(true)
    })

    it('refuses a non-boolean flag rather than coercing it', async () => {
      const res = await patchMerchant(merchantId, ownerToken, { pickup_enabled: 'false' })
      expect(res.status).toBe(400)
      expect(((await res.json()) as any).error).toMatch(/pickup_enabled must be a boolean/)
    })
  })
})

// Custom order dates (#210, ADR 0015). What is pinned here is the NORMALISATION: the bag the row
// ends up holding is the one this handler produces — sorted, deduped, clamped, unknown keys
// dropped — never the one that arrived, and a body that never mentions fulfilment must not
// silently rewrite it.
describe('PATCH /api/merchants/:id (custom order dates)', () => {
  let merchantId: string
  let ownerToken: string

  // Dates computed from the run's own clock, so this suite cannot rot into the past.
  const iso = (offsetDays: number) => {
    const d = new Date(Date.now() + offsetDays * 86_400_000)
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  }

  beforeEach(async () => {
    await resetMerchant('cfg-dates-shop')
    const client = await makeUser('cfg-dates@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    merchantId = await seedMerchant({ slug: 'cfg-dates-shop', owner_id: userId })
    ownerToken = token
  })

  const setStored = (fulfilment: Record<string, unknown>) =>
    serviceClient().from('merchants').update({ config: { fulfilment } }).eq('id', merchantId)

  const save = (fulfilment: Record<string, unknown>) =>
    patch(`/api/merchants/${merchantId}`, { config: { fulfilment } }, ownerToken)

  it('lets a shop switch to custom dates', async () => {
    const res = await save({ mode: 'custom', custom_dates: [iso(7)] })
    expect(res.status).toBe(200)
    const row = (await res.json()) as any
    expect(row.config.fulfilment.mode).toBe('custom')
    expect(row.config.fulfilment.custom_dates).toEqual([iso(7)])
  })

  // A paused shop must be able to make the ONE write that reopens it: clearing needs_review.
  it('lets a paused shop confirm its window without touching the dates', async () => {
    await setStored({ mode: 'rolling', custom_dates: [iso(7)], needs_review: true })
    const res = await save({ mode: 'rolling', custom_dates: [iso(7)], needs_review: false })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).config.fulfilment.needs_review).toBe(false)
  })

  it('refuses a custom save with no dates — the merchant cannot pause their own shop from the form', async () => {
    const res = await save({ mode: 'custom', custom_dates: [] })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('no_dates')
  })

  it('refuses a date beyond the 90-day horizon', async () => {
    const res = await save({ mode: 'custom', custom_dates: [iso(120)] })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('beyond_horizon')
  })

  it('normalises the bag it stores rather than trusting the body', async () => {
    const res = await patch(`/api/merchants/${merchantId}`, {
      config: { fulfilment: { mode: 'custom', custom_dates: [iso(9), iso(7), iso(7)], junk: 'x', window_days: 9999 } },
    }, ownerToken)
    expect(res.status).toBe(200)
    const f = ((await res.json()) as any).config.fulfilment
    expect(f.custom_dates).toEqual([iso(7), iso(9)])   // sorted, deduped
    expect(f.window_days).toBe(90)                     // clamped to the horizon
    expect(f.junk).toBeUndefined()                     // unknown keys do not survive
  })

  // Found in review. `fulfilmentConfig` reads a bag with no `fulfilment` key as DEFAULT_FULFILMENT,
  // so normalising on the PRESENCE of `config` writes that default over the row — clearing the
  // dates and lifting the ADR 0015 pause behind a success toast. Latent (only FulfilmentTab sends
  // `config` today, and it spreads the stored bag) but it is the presence-vs-change mistake sitting
  // one function away from the gate that exists to avoid it.
  it('carries the stored fulfilment forward when a config PATCH does not mention it', async () => {
    await setStored({ mode: 'rolling', custom_dates: [iso(7)], needs_review: true })
    const res = await patch(`/api/merchants/${merchantId}`, { config: { something_else: 1 } }, ownerToken)
    expect(res.status).toBe(200)
    const f = ((await res.json()) as any).config.fulfilment
    expect(f.needs_review).toBe(true)          // the pause survives a write that never named it
    expect(f.custom_dates).toEqual([iso(7)])
  })

  it('leaves a shop with no stored fulfilment alone rather than inventing one', async () => {
    await serviceClient().from('merchants').update({ config: {} }).eq('id', merchantId)
    const res = await patch(`/api/merchants/${merchantId}`, { config: { something_else: 1 } }, ownerToken)
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).config.fulfilment).toBeUndefined()
  })

  // Found in review. `fulfilmentConfig` caps the array at MAX_CUSTOM_DATES, so validating the
  // ALREADY-TRUNCATED list could never report `too_many` — a 200-date body saved 91 silently,
  // which is exactly the "refused, never trimmed" rule the handler states one line above.
  it('refuses an over-long allowlist rather than truncating it', async () => {
    const many = Array.from({ length: 95 }, (_, i) => iso(i + 1))
    const res = await save({ mode: 'custom', custom_dates: many })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('too_many')
  })

  it('normalises the fulfilment key without disturbing the rest of the config bag', async () => {
    const res = await patch(`/api/merchants/${merchantId}`, {
      config: { fulfilment: { lead_days: 3 }, something_else: { kept: true } },
    }, ownerToken)
    expect(res.status).toBe(200)
    const cfg = ((await res.json()) as any).config
    expect(cfg.fulfilment.lead_days).toBe(3)
    expect(cfg.something_else).toEqual({ kept: true })
  })
})

// The shop's OWN advertising pixel (#220). What is pinned here is the id VALIDATION and the
// public read: a malformed id is refused where the merchant can still see the form, and the ids
// reach an anonymous storefront visitor, or the browser has nothing to decide with.
describe('PATCH /api/merchants/:id — the shop’s own ad pixel', () => {
  let merchantId: string
  let ownerToken: string

  beforeEach(async () => {
    await resetMerchant('cfg-pixel-shop')
    const client = await makeUser('cfg-pixel@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    merchantId = await seedMerchant({ slug: 'cfg-pixel-shop', owner_id: userId })
    ownerToken = token
  })

  const setStored = (meta: string | null) =>
    serviceClient().from('merchants').update({ meta_pixel_id: meta }).eq('id', merchantId)

  const save = (body: Record<string, unknown>) =>
    patch(`/api/merchants/${merchantId}`, body, ownerToken)

  it('lets a shop set its pixel ids', async () => {
    const res = await save({ meta_pixel_id: '123456789012345', tiktok_pixel_id: 'CQ1234567890ABCDEFGH' })
    expect(res.status).toBe(200)
    const row = (await res.json()) as any
    expect(row.meta_pixel_id).toBe('123456789012345')
    expect(row.tiktok_pixel_id).toBe('CQ1234567890ABCDEFGH')
  })

  // ShopSettings resubmits a whole config bag, so an untouched pixel id rides along with an
  // ordinary shipping edit.
  it('lets a shop resubmit its existing pixel unchanged alongside other edits', async () => {
    await setStored('123456789012345')
    const res = await save({ meta_pixel_id: '123456789012345', pickup_address: 'Lot 4' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).pickup_address).toBe('Lot 4')
  })

  // Removing a pixel STOPS third-party tracking, so it must always be possible.
  it('lets a shop REMOVE its pixel', async () => {
    await setStored('123456789012345')
    const res = await save({ meta_pixel_id: '' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).meta_pixel_id).toBeNull()
  })

  it('refuses a malformed id rather than storing it, where the merchant can still see the form', async () => {
    const res = await save({ meta_pixel_id: 'act_12345678' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toContain('meta_pixel_id')
  })

  // Public storefront read: the ids have to reach an anonymous visitor, or the browser has
  // nothing to decide with. This is the only endpoint that carries them.
  it('ships the pixel ids on the public storefront lookup', async () => {
    await save({ meta_pixel_id: '123456789012345' })
    const res = await app.request('/api/merchants/cfg-pixel-shop')
    expect(res.status).toBe(200)
    const row = (await res.json()) as any
    expect(row.meta_pixel_id).toBe('123456789012345')
  })
})

describe('PATCH /api/merchants/:id — the shop’s own description', () => {
  let merchantId: string
  let ownerToken: string

  beforeEach(async () => {
    await resetMerchant('cfg-descr-shop')
    const client = await makeUser('cfg-descr@example.com', 'password123')
    const { token, userId } = await tokenOf(client)
    merchantId = await seedMerchant({ slug: 'cfg-descr-shop', owner_id: userId })
    ownerToken = token
  })

  const save = (body: Record<string, unknown>) =>
    patch(`/api/merchants/${merchantId}`, body, ownerToken)

  it('stores both languages, trimmed', async () => {
    const res = await save({
      description: '  Home-style kuih, order a day ahead. ',
      description_zh: ' 家庭式面包，请提前一天下单。 ',
    })
    expect(res.status).toBe(200)
    const row = (await res.json()) as any
    expect(row.description).toBe('Home-style kuih, order a day ahead.')
    expect(row.description_zh).toBe('家庭式面包，请提前一天下单。')
  })

  // Clearing the blurb is the only way back to a storefront with no line under its name, so it
  // must always be possible — and it must land as NULL, not as a blank string the storefront
  // would then render as an empty paragraph.
  it('lets a shop REMOVE its description', async () => {
    await save({ description: 'Home-style kuih' })
    const res = await save({ description: '' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).description).toBeNull()
  })

  it('refuses an over-long blurb rather than truncating it', async () => {
    const res = await save({ description: 'a'.repeat(SHOP_DESCRIPTION_MAX + 1) })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toContain('description')
  })

  // The public storefront read is where the blurb actually gets used: an anonymous visitor is
  // the whole audience for it.
  it('ships the description on the public storefront lookup', async () => {
    await save({ description: 'Home-style kuih', description_zh: '家庭式糕点' })
    const res = await app.request('/api/merchants/cfg-descr-shop')
    expect(res.status).toBe(200)
    const row = (await res.json()) as any
    expect(row.description).toBe('Home-style kuih')
    expect(row.description_zh).toBe('家庭式糕点')
  })
})
