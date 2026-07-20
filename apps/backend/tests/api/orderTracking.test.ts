// tests/api/orderTracking.test.ts
// POST /api/orders/track, driven in-process through app.request() against a real Postgres.
//
// It replaces the `track_order` SECURITY DEFINER function, and inherits its two security
// properties whole:
//
//   1. A wrong order number and a wrong phone are INDISTINGUISHABLE. Order numbers are a
//      per-shop daily counter, so the number alone is guessable and this endpoint is open to
//      anyone. The phone is the only thing making a guess cost ~10^8 tries instead of one —
//      and any response that separates "no such order" from "wrong phone" hands that back.
//   2. The merchant scope is enforced in TypeScript. db.ts is RLS-EXEMPT, so no policy is
//      standing behind this query: an order from another shop is kept out by the `where`
//      clause and by nothing else. That is what this suite is here to prove.
//
// Never mocked — see vitest.db.config.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { app } from '../../src/app.js'
import { trackOrder } from '../../src/orderTracking.js'
import { makeUser, resetMerchant, seedMerchant, serviceClient } from '../rls/helpers.js'

const SLUGS = ['track-shop', 'track-other']
const ORDER_NO = 'TR-20260714-0001'
const PHONE = '60123456789'

function track(body: unknown) {
  return app.request('/api/orders/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Status, headers and body together — the whole observable response, for comparing misses. */
async function responseShape(res: Response) {
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    body: await res.text(),
  }
}

describe('POST /api/orders/track', () => {
  let shop: string
  let otherShop: string

  beforeAll(async () => {
    const owner = await makeUser('track-owner@test.dev', 'password123')
    const otherOwner = await makeUser('track-other-owner@test.dev', 'password123')
    const ownerId = (await owner.auth.getUser()).data.user!.id
    const otherOwnerId = (await otherOwner.auth.getUser()).data.user!.id

    shop = await seedMerchant({ slug: 'track-shop', order_prefix: 'TR', owner_id: ownerId })
    otherShop = await seedMerchant({ slug: 'track-other', order_prefix: 'TR', owner_id: otherOwnerId })

    const svc = serviceClient()
    await svc.from('orders').insert([
      {
        merchant_id: shop,
        order_number: ORDER_NO,
        customer_name: 'Ah Meng',
        customer_wa: PHONE,
        mode: 'delivery',
        status: 'shipped',
        courier: 'jnt',
        awb: 'JT123456789',
        items: [{ id: 'p1', name: 'Matcha Cookie', qty: 1, price: 13 }],
        total: 13,
        created_at: '2026-07-14T02:00:00Z',
      },
      // An order with no phone on file. It must be unreachable — including by a request that
      // sends no phone, which normalises to the same empty string it does.
      {
        merchant_id: shop,
        order_number: 'TR-20260714-0002',
        customer_name: 'No Phone',
        customer_wa: null,
        mode: 'pickup',
        status: 'new',
        items: [],
        total: 0,
      },
      // Same order number, same phone — but a different shop's order.
      {
        merchant_id: otherShop,
        order_number: ORDER_NO,
        customer_name: 'Someone Else',
        customer_wa: PHONE,
        mode: 'pickup',
        status: 'done',
        awb: 'SECRET-AWB',
        items: [],
        total: 5,
      },
      // Carries a fulfilment date, to prove the driver's Date is rendered back as the same
      // YYYY-MM-DD it was stored with, not shifted by a UTC/local mismatch. `created_at` is
      // stated explicitly, not left to the column default: a batch `.insert([...])` with mixed
      // keys sends NULL for any column a row omits, rather than falling through to `now()`.
      {
        merchant_id: shop,
        order_number: 'TR-20260714-0004',
        customer_name: 'Has A Date',
        customer_wa: PHONE,
        mode: 'pickup',
        status: 'new',
        items: [],
        total: 0,
        fulfil_date: '2026-07-22',
        created_at: '2026-07-14T02:00:00Z',
      },
    ])
  }, 30_000)

  afterAll(async () => {
    for (const slug of SLUGS) await resetMerchant(slug)
  })

  it('returns the order’s status, mode, courier, AWB, created_at and fulfil_date', async () => {
    const res = await track({ merchantId: shop, orderNumber: ORDER_NO, phone: PHONE })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: 'shipped',
      mode: 'delivery',
      courier: 'jnt',
      awb: 'JT123456789',
      created_at: '2026-07-14T02:00:00.000Z',
      fulfil_date: null,
    })
  })

  it('needs no authentication — no Authorization header is sent above', async () => {
    const res = await track({ merchantId: shop, orderNumber: ORDER_NO, phone: PHONE })

    expect(res.status).toBe(200)
  })

  it('never returns the phone it matched on', async () => {
    const res = await track({ merchantId: shop, orderNumber: ORDER_NO, phone: PHONE })

    expect(await res.text()).not.toContain(PHONE)
  })

  // The rule that keeps customers in: one human, one phone, three ways of writing it.
  it.each(['+60 12-345 6789', '0123456789', '60123456789'])('matches the phone written as %s', async (phone) => {
    const res = await track({ merchantId: shop, orderNumber: ORDER_NO, phone })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ awb: 'JT123456789' })
  })

  // ── The property the whole endpoint exists to preserve ───────────────────────
  //
  // If any of these ever diverge, the endpoint has become the enumeration oracle the phone
  // requirement was added to remove: a caller could walk a shop's daily counter and learn
  // which numbers are real orders, then work on the phone at leisure.

  it('answers a wrong phone exactly as it answers a wrong order number', async () => {
    const wrongPhone = await track({ merchantId: shop, orderNumber: ORDER_NO, phone: '60199999999' })
    const wrongNumber = await track({ merchantId: shop, orderNumber: 'TR-20260714-9999', phone: PHONE })

    expect(await responseShape(wrongPhone)).toEqual(await responseShape(wrongNumber))
  })

  it('answers both with a bare null, carrying no error code or message', async () => {
    const res = await track({ merchantId: shop, orderNumber: ORDER_NO, phone: '60199999999' })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('null')
  })

  it('answers a missing phone and a missing order number identically too', async () => {
    const noPhone = await track({ merchantId: shop, orderNumber: ORDER_NO })
    const noNumber = await track({ merchantId: shop, phone: PHONE })
    const nothing = await responseShape(await track({}))

    expect(await responseShape(noPhone)).toEqual(nothing)
    expect(await responseShape(noNumber)).toEqual(nothing)
  })

  it('answers a malformed body the same way, rather than failing loudly', async () => {
    const res = await app.request('/api/orders/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })

    expect(await responseShape(res)).toEqual(await responseShape(await track({})))
  })

  // ── Tenancy, enforced in TypeScript because db.ts is RLS-exempt ─────────────

  it('never returns another shop’s order, even with its number and phone right', async () => {
    const res = await track({ merchantId: shop, orderNumber: ORDER_NO, phone: PHONE })
    const body = await res.text()

    expect(body).not.toContain('SECRET-AWB')
    expect(JSON.parse(body)).toMatchObject({ awb: 'JT123456789' })
  })

  it('does not let a made-up merchant id reach an order', async () => {
    const res = await track({
      merchantId: '00000000-0000-0000-0000-000000000000',
      orderNumber: ORDER_NO,
      phone: PHONE,
    })

    expect(await res.text()).toBe('null')
  })

  // ── An order with no phone on file is unreachable ───────────────────────────

  it('never matches a phone-less order with an empty phone', async () => {
    const empty = await track({ merchantId: shop, orderNumber: 'TR-20260714-0002', phone: '' })
    const absent = await track({ merchantId: shop, orderNumber: 'TR-20260714-0002' })

    expect(await empty.text()).toBe('null')
    expect(await absent.text()).toBe('null')
  })

  // The one thing the HTTP seam cannot see. postgres.js hands back a Date for timestamptz and
  // `sql<T[]>` is an unchecked assertion, so tsc believes a declared `created_at: string` that
  // is really a Date — and c.json() stringifies it to identical text, so the assertion on the
  // response above passes either way. A backend caller who trusts the type finds out instead.
  it('hands back created_at as a real string, not the driver’s Date', async () => {
    const result = await trackOrder(shop, ORDER_NO, PHONE)

    expect(typeof result?.created_at).toBe('string')
  })

  it('hands back fulfil_date as the same YYYY-MM-DD it was stored with', async () => {
    const result = await trackOrder(shop, 'TR-20260714-0004', PHONE)

    expect(result?.fulfil_date).toBe('2026-07-22')
  })
})
