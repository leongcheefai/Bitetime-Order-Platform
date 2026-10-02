// tests/rls/order-payments-grant.test.ts
// order_payments is read and written by the backend only (db.ts). A browser role must not SELECT
// or INSERT a row — not the shop owner, not an anonymous visitor. Mirrors order-events-grant.test.ts:
// if this ever passes with rows, a policy or a grant crept in.
import { describe, it, expect } from 'vitest'
import { anonClient, makeUser, serviceClient, seedMerchant, resetMerchant } from './helpers.js'

const SLUG = 'order-payments-grant-shop'

async function seedOrderWithPayment() {
  const svc = serviceClient()
  const owner = await makeUser('order-payments-grant-owner@example.com', 'password123')
  const { data: session } = await owner.auth.getSession()
  await resetMerchant(SLUG)
  const merchantId = await seedMerchant({ slug: SLUG, owner_id: session.session!.user.id, status: 'active' })
  const { data: order, error } = await svc.from('orders').insert({
    merchant_id: merchantId,
    order_number: `OP-${crypto.randomUUID().slice(0, 8)}`,
    status: 'pending_payment',
    customer_name: 'Ah Meng',
    customer_wa: '60123456789',
  }).select('id').single()
  if (error) throw new Error(`seeding order: ${error.message}`)
  const { error: pErr } = await svc.from('order_payments').insert({
    order_id: order!.id, merchant_id: merchantId, gateway: 'hitpay',
    gateway_request_id: `req-${crypto.randomUUID()}`, qr_payload: 'x', amount: 10, currency: 'MYR',
    status: 'pending', expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  })
  if (pErr) throw new Error(`seeding payment: ${pErr.message}`)
  return { orderId: order!.id as string, merchantId, owner }
}

describe('order_payments is not reachable by the browser', () => {
  it('denies an anonymous SELECT', async () => {
    await seedOrderWithPayment()
    const { data, error } = await anonClient().from('order_payments').select('*')
    expect(error !== null || (data ?? []).length === 0).toBe(true)
  })

  it('denies the shop owner a SELECT and an INSERT', async () => {
    const { orderId, merchantId, owner } = await seedOrderWithPayment()
    const read = await owner.from('order_payments').select('*').eq('order_id', orderId)
    expect(read.error).not.toBeNull()
    const write = await owner.from('order_payments').insert({
      order_id: orderId, merchant_id: merchantId, gateway: 'hitpay', gateway_request_id: 'forged',
      qr_payload: 'x', amount: 1, currency: 'MYR', status: 'completed', expires_at: new Date().toISOString(),
    })
    expect(write.error).not.toBeNull()
  })

  it('allows only one pending row for each order', async () => {
    const { orderId, merchantId } = await seedOrderWithPayment()
    const { error } = await serviceClient().from('order_payments').insert({
      order_id: orderId, merchant_id: merchantId, gateway: 'hitpay',
      gateway_request_id: `req-${crypto.randomUUID()}`, qr_payload: 'y', amount: 10, currency: 'MYR',
      status: 'pending', expires_at: new Date(Date.now() + 60_000).toISOString(),
    })
    expect(error?.code).toBe('23505')
  })
})
