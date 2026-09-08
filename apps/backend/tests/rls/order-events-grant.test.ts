// tests/rls/order-events-grant.test.ts
// The order log is read and written by the backend only. A browser role must not be able to
// SELECT an order's events directly — not even the merchant who owns the order, and not the
// customer who placed it — and must not be able to INSERT one (ADR 0025: an event is written with
// the action that caused it, on the backend's own connection, or not at all). Mirrors
// releases-grant.test.ts: if this ever passes with rows, a policy or grant crept in.
import { describe, it, expect } from 'vitest'
import { anonClient, makeUser, serviceClient, seedMerchant, resetMerchant } from './helpers.js'

const SLUG = 'order-events-grant-shop'

async function seedOrderWithEvent() {
  const svc = serviceClient()
  const owner = await makeUser('order-events-grant-owner@example.com', 'password123')
  const { data: session } = await owner.auth.getSession()
  await resetMerchant(SLUG)
  const merchantId = await seedMerchant({ slug: SLUG, owner_id: session.session!.user.id, status: 'active' })
  const { data: order, error } = await svc.from('orders').insert({
    merchant_id: merchantId,
    order_number: `OE-${crypto.randomUUID().slice(0, 8)}`,
    status: 'new',
    customer_name: 'Ah Meng',
    customer_wa: '60123456789',
  }).select('id').single()
  if (error) throw new Error(`seeding order: ${error.message}`)
  const { error: evErr } = await svc.from('order_events').insert({
    order_id: order!.id, merchant_id: merchantId, kind: 'created', actor_kind: 'customer', detail: { status: 'new' },
  })
  if (evErr) throw new Error(`seeding event: ${evErr.message}`)
  return { orderId: order!.id as string, merchantId, owner }
}

describe('order_events is not reachable by the browser', () => {
  it('denies an anonymous SELECT', async () => {
    await seedOrderWithEvent()
    const { data, error } = await anonClient().from('order_events').select('*')
    expect(error !== null || (data ?? []).length === 0).toBe(true)
    if (error) expect(error.message.toLowerCase()).toContain('permission denied')
  })

  it('denies the shop owner a SELECT and an INSERT', async () => {
    const { orderId, merchantId, owner } = await seedOrderWithEvent()

    const read = await owner.from('order_events').select('*').eq('order_id', orderId)
    expect(read.error).not.toBeNull()
    expect(read.error?.code === '42501' || read.error?.message.toLowerCase().includes('permission denied')).toBe(true)

    const write = await owner.from('order_events').insert({
      order_id: orderId, merchant_id: merchantId, kind: 'status_changed', actor_kind: 'merchant',
      detail: { from: 'new', to: 'completed' },
    })
    expect(write.error).not.toBeNull()
    expect(write.error?.code === '42501' || write.error?.message.toLowerCase().includes('permission denied')).toBe(true)
  })
})
