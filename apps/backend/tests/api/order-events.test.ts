// tests/api/order-events.test.ts
// The order log (#268, ADR 0025): every write to an order leaves an event, in the same
// transaction as the write. These cases drive the real routes and read the log back over db.ts
// — `order_events` holds no PostgREST grant for the browser roles, so a REST read would come
// back empty and prove nothing.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { sql } from '../../src/db.js'
import { app } from '../../src/app.js'
import { makeUser, resetMerchant, seedMerchant, seedProduct, serviceClient } from '../rls/helpers.js'
import { todayInZone, DEFAULT_TIMEZONE } from '@bitetime/shared'

const SLUG = 'order-events-shop'

function tomorrowInShopZone(): string {
  const today = todayInZone(DEFAULT_TIMEZONE, new Date())
  return new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
}

async function tokenOf(client: Awaited<ReturnType<typeof makeUser>>) {
  const { data } = await client.auth.getSession()
  return { token: data.session!.access_token, userId: data.session!.user.id }
}

function placeOrder(merchantId: string, productId: string, token?: string) {
  return app.request('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({
      merchantId,
      customerName: 'Ah Meng',
      customerWa: '60123456789',
      mode: 'pickup',
      cart: [{ productId, qty: 1, selections: [] }],
      quotedTotal: 13,
      fulfilDate: tomorrowInShopZone(),
    }),
  })
}

const PNG_1X1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
)

/** An order seeded straight into the table — no `created` event, like every order before #268. */
async function seedOrder(merchantId: string, status: string, userId?: string) {
  const { data, error } = await serviceClient()
    .from('orders')
    .insert({
      merchant_id: merchantId,
      order_number: `OE-${crypto.randomUUID().slice(0, 8)}`,
      status,
      customer_name: 'Ah Meng',
      customer_wa: '60123456789',
      ...(userId ? { user_id: userId } : {}),
    })
    .select('id')
    .single()
  if (error) throw new Error(`seeding order: ${error.message}`)
  return data!.id as string
}

type EventRow = { kind: string; actor_kind: string; actor_id: string | null; detail: Record<string, unknown> }

async function eventsOf(orderId: string): Promise<EventRow[]> {
  return await sql<EventRow[]>`
    select kind, actor_kind, actor_id, detail from order_events
    where order_id = ${orderId} order by id
  `
}

describe('order log', () => {
  let shop: string
  let productId: string
  let customer: { token: string; userId: string }
  let owner: { token: string; userId: string }

  beforeAll(async () => {
    await resetMerchant(SLUG)
    const own = await makeUser('order-events-owner@test.dev', 'password123')
    const cust = await makeUser('order-events-customer@test.dev', 'password123')
    customer = await tokenOf(cust)
    owner = await tokenOf(own)
    shop = await seedMerchant({ slug: SLUG, owner_id: owner.userId, status: 'active' })
  })

  beforeEach(async () => {
    productId = await seedProduct({ merchant_id: shop, price: 13 })
  })

  describe('created', () => {
    it('is recorded for a signed-in customer, with their id and the birth status', async () => {
      const res = await placeOrder(shop, productId, customer.token)
      expect(res.status).toBe(200)
      const { id } = (await res.json()) as { id: string }

      expect(await eventsOf(id)).toEqual([
        { kind: 'created', actor_kind: 'customer', actor_id: customer.userId, detail: { status: 'new' } },
      ])
    })

    it('is recorded for a guest as a customer with no id', async () => {
      const res = await placeOrder(shop, productId)
      expect(res.status).toBe(200)
      const { id } = (await res.json()) as { id: string }

      expect(await eventsOf(id)).toEqual([
        { kind: 'created', actor_kind: 'customer', actor_id: null, detail: { status: 'new' } },
      ])
    })
  })

  describe('payment proof', () => {
    it('records the customer upload, and the status move it caused as the system', async () => {
      const orderId = await seedOrder(shop, 'pending_payment', customer.userId)
      const res = await app.request(`/api/orders/${orderId}/payment-proof`, {
        method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG_1X1,
      })
      expect(res.status).toBe(200)

      expect(await eventsOf(orderId)).toEqual([
        { kind: 'payment_proof_uploaded', actor_kind: 'customer', actor_id: customer.userId, detail: {} },
        { kind: 'status_changed', actor_kind: 'system', actor_id: null, detail: { from: 'pending_payment', to: 'new' } },
      ])
    })

    it('records a guest upload with no actor id, and no status move when there was none', async () => {
      const orderId = await seedOrder(shop, 'new')
      const res = await app.request(`/api/orders/${orderId}/payment-proof`, {
        method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG_1X1,
      })
      expect(res.status).toBe(200)

      expect(await eventsOf(orderId)).toEqual([
        { kind: 'payment_proof_uploaded', actor_kind: 'customer', actor_id: null, detail: {} },
      ])
      // The customer's response carries no log — the customer does not see it.
      expect(await res.json()).not.toHaveProperty('events')
    })

    it("records the shop's own receipt as the merchant, and hands the events back", async () => {
      const orderId = await seedOrder(shop, 'pending_payment')
      const res = await app.request(`/api/merchants/${shop}/orders/${orderId}/merchant-payment-proof`, {
        method: 'POST', headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${owner.token}` }, body: PNG_1X1,
      })
      expect(res.status).toBe(200)

      const expected = [
        { kind: 'merchant_payment_proof_uploaded', actor_kind: 'merchant', actor_id: owner.userId, detail: {} },
        { kind: 'status_changed', actor_kind: 'system', actor_id: null, detail: { from: 'pending_payment', to: 'new' } },
      ]
      expect(await eventsOf(orderId)).toEqual(expected)
      const body = (await res.json()) as { events: (EventRow & { created_at: string })[] }
      expect(body.events.map((e: EventRow) => ({ kind: e.kind, actor_kind: e.actor_kind, actor_id: e.actor_id, detail: e.detail }))).toEqual(expected)
      expect(typeof body.events[0].created_at).toBe('string')
    })
  })

  function patchOrder(orderId: string, patch: Record<string, unknown>) {
    return app.request(`/api/merchants/${shop}/orders/${orderId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify(patch),
    })
  }

  describe('merchant patch', () => {
    it('records a status move as the merchant and hands the event back with the row', async () => {
      const orderId = await seedOrder(shop, 'new')
      const res = await patchOrder(orderId, { status: 'preparing' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { status: string; events: EventRow[] }
      expect(body.status).toBe('preparing')
      expect(body.events.map(e => e.kind)).toEqual(['status_changed'])

      expect(await eventsOf(orderId)).toEqual([
        { kind: 'status_changed', actor_kind: 'merchant', actor_id: owner.userId, detail: { from: 'new', to: 'preparing' } },
      ])
    })

    it('records a note change without the note, and nothing for a note saved unchanged', async () => {
      const orderId = await seedOrder(shop, 'new')
      await patchOrder(orderId, { note: 'ring the bell' })
      const again = await patchOrder(orderId, { note: 'ring the bell' })
      expect(((await again.json()) as { events: EventRow[] }).events).toEqual([])

      expect(await eventsOf(orderId)).toEqual([
        { kind: 'note_changed', actor_kind: 'merchant', actor_id: owner.userId, detail: {} },
      ])
    })

    it('records the voucher use a cancellation returns, and the one an un-cancel takes back', async () => {
      await serviceClient().from('vouchers').delete().eq('merchant_id', shop).eq('code', 'LOG5')
      const { error } = await serviceClient().from('vouchers')
        .insert({ merchant_id: shop, code: 'LOG5', kind: 'fixed', amount: 5, max_uses: null, used_by: [] })
      if (error) throw new Error(error.message)
      const placed = await app.request('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customer.token}` },
        body: JSON.stringify({
          merchantId: shop, customerName: 'Ah Meng', customerWa: '60123456789', mode: 'pickup',
          cart: [{ productId, qty: 1, selections: [] }], quotedTotal: 8, fulfilDate: tomorrowInShopZone(), voucherCode: 'LOG5',
        }),
      })
      expect(placed.status).toBe(200)
      const { id: orderId } = (await placed.json()) as { id: string }

      await patchOrder(orderId, { status: 'cancelled' })
      await patchOrder(orderId, { status: 'cancelled' })   // a repeat records nothing
      await patchOrder(orderId, { status: 'new' })

      expect((await eventsOf(orderId)).slice(1)).toEqual([
        { kind: 'status_changed', actor_kind: 'merchant', actor_id: owner.userId, detail: { from: 'new', to: 'cancelled' } },
        { kind: 'voucher_released', actor_kind: 'system', actor_id: null, detail: { code: 'LOG5' } },
        { kind: 'status_changed', actor_kind: 'merchant', actor_id: owner.userId, detail: { from: 'cancelled', to: 'new' } },
        { kind: 'voucher_restored', actor_kind: 'system', actor_id: null, detail: { code: 'LOG5' } },
      ])
    })

    it('refuses to move a completed order and records nothing (ADR 0024, judged under the lock)', async () => {
      const orderId = await seedOrder(shop, 'completed')
      const res = await patchOrder(orderId, { status: 'cancelled' })
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'order_completed' })
      expect(await eventsOf(orderId)).toEqual([])
    })

    it('records no voucher event for an order that spent none', async () => {
      const orderId = await seedOrder(shop, 'new')
      await patchOrder(orderId, { status: 'cancelled' })
      expect((await eventsOf(orderId)).map(e => e.kind)).toEqual(['status_changed'])
    })

    // The date edit. The rule is the CUSTOMER's — `isDateSelectable`, the shop's own Fulfilment
    // settings — judged on the shop's clock under the same lock as every other patch. A refused
    // date records nothing.
    describe('fulfil_date', () => {
      function plusDays(days: number): string {
        const today = todayInZone(DEFAULT_TIMEZONE, new Date())
        return new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
      }
      function weekdayOf(iso: string): number {
        return new Date(`${iso}T00:00:00Z`).getUTCDay()
      }
      async function setFulfilment(fulfilment: Record<string, unknown>) {
        const { error } = await serviceClient().from('merchants').update({ config: { fulfilment } }).eq('id', shop)
        if (error) throw new Error(error.message)
      }

      beforeEach(async () => {
        // Back to the shop every test file assumes: rolling, 0 / 14 / open every day.
        await setFulfilment({ mode: 'rolling', lead_days: 0, window_days: 14, closed_weekdays: [] })
      })

      it('moves the date, records both ends, and hands the row back with the new day', async () => {
        const orderId = await seedOrder(shop, 'new')
        const to = plusDays(3)
        const res = await patchOrder(orderId, { fulfil_date: to })
        expect(res.status).toBe(200)
        const body = (await res.json()) as { fulfil_date: string; events: EventRow[] }
        expect(body.fulfil_date).toBe(to)
        expect(body.events.map(e => e.kind)).toEqual(['fulfil_date_changed'])

        expect(await eventsOf(orderId)).toEqual([
          { kind: 'fulfil_date_changed', actor_kind: 'merchant', actor_id: owner.userId, detail: { from: null, to } },
        ])
      })

      it('records nothing for the date saved unchanged', async () => {
        const orderId = await seedOrder(shop, 'new')
        const to = plusDays(2)
        await patchOrder(orderId, { fulfil_date: to })
        const again = await patchOrder(orderId, { fulfil_date: to })
        expect(again.status).toBe(200)
        expect(((await again.json()) as { events: EventRow[] }).events).toEqual([])
        expect((await eventsOf(orderId)).length).toBe(1)
      })

      it("refuses a day the shop's own settings do not offer, and records nothing", async () => {
        const orderId = await seedOrder(shop, 'new')
        const tomorrow = plusDays(1)
        await setFulfilment({ mode: 'rolling', lead_days: 2, window_days: 14, closed_weekdays: [weekdayOf(plusDays(5))] })
        for (const [value, why] of [
          [plusDays(-1), 'yesterday'],
          [tomorrow, 'inside the lead time'],
          [plusDays(5), 'a closed weekday'],
          [plusDays(20), 'past the window'],
          ['25/07/2026', 'not a date'],
        ] as const) {
          const res = await patchOrder(orderId, { fulfil_date: value })
          expect(res.status, why).toBe(409)
          expect(await res.json(), why).toEqual({ error: 'fulfil_date_unavailable' })
        }
        expect(await eventsOf(orderId)).toEqual([])
      })

      it('in custom mode, takes a ticked day and refuses an unticked one', async () => {
        const orderId = await seedOrder(shop, 'new')
        const ticked = plusDays(4)
        await setFulfilment({ mode: 'custom', custom_dates: [ticked] })
        expect((await patchOrder(orderId, { fulfil_date: plusDays(3) })).status).toBe(409)
        const res = await patchOrder(orderId, { fulfil_date: ticked })
        expect(res.status).toBe(200)
        expect(((await res.json()) as { fulfil_date: string }).fulfil_date).toBe(ticked)
      })

      it('refuses to move the date of a completed order and records nothing (ADR 0024)', async () => {
        const orderId = await seedOrder(shop, 'completed')
        const res = await patchOrder(orderId, { fulfil_date: plusDays(1) })
        expect(res.status).toBe(409)
        expect(await res.json()).toEqual({ error: 'order_completed' })
        expect(await eventsOf(orderId)).toEqual([])
      })

      it('refuses a body that tries to clear the date', async () => {
        const orderId = await seedOrder(shop, 'new')
        const res = await patchOrder(orderId, { fulfil_date: null })
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({ error: 'No updatable fields' })
      })
    })
  })

  describe('GET /api/merchants/:id/orders/:orderId/events', () => {
    it('lists the log oldest first for the shop that owns the order', async () => {
      const orderId = await seedOrder(shop, 'new')
      await patchOrder(orderId, { status: 'preparing' })
      await patchOrder(orderId, { status: 'ready' })

      const res = await app.request(`/api/merchants/${shop}/orders/${orderId}/events`, {
        headers: { Authorization: `Bearer ${owner.token}` },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { events: (EventRow & { id: string; created_at: string })[] }
      expect(body.events.map(e => e.detail.to)).toEqual(['preparing', 'ready'])
      expect(typeof body.events[0].id).toBe('string')
      expect(typeof body.events[0].created_at).toBe('string')
    })

    it("is a 404 for another shop's order nested under this shop", async () => {
      const otherOwner = await tokenOf(await makeUser('order-events-stranger@test.dev', 'password123'))
      await resetMerchant('order-events-other')
      const other = await seedMerchant({ slug: 'order-events-other', owner_id: otherOwner.userId, status: 'active' })
      const orderId = await seedOrder(other, 'new')

      const res = await app.request(`/api/merchants/${shop}/orders/${orderId}/events`, {
        headers: { Authorization: `Bearer ${owner.token}` },
      })
      expect(res.status).toBe(404)
    })
  })
})
