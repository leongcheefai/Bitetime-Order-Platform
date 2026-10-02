// tests/api/hitpay-alerts.test.ts
// Who hears about a HitPay order, and when. The notify adapters are faked through `notifyDeps`;
// HitPay through `hitpayDeps`; Postgres is real, because the merchant email's one-shot claim is a
// row update that only Postgres can prove.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { app, hitpayDeps, notifyDeps } from '../../src/app.js'
import type { Hitpay } from '../../src/hitpay.js'
import { makeUser, seedMerchant, serviceClient } from '../rls/helpers.js'

const svc = () => serviceClient()
const realHitpay = { ...hitpayDeps }
const realNotify = { ...notifyDeps }
const telegrams: string[] = []
const emails: { to: string; subject: string; text: string }[] = []
let paid = new Set<string>()

const fakeHitpay: Hitpay = {
  async registerWebhook() { return { id: 'wh' } },
  async removeWebhook() {},
  async createQr(_b, _k, input) { return { id: `pr_${input.reference}`, qrPayload: 'qr' } },
  async getPaymentRequest(_b, _k, id) {
    const orderId = id.slice(3)
    return { id, status: paid.has(orderId) ? 'completed' : 'pending', amount: '10.00', currency: 'myr', referenceNumber: orderId }
  },
}

beforeEach(() => {
  telegrams.length = 0
  emails.length = 0
  paid = new Set()
  hitpayDeps.hitpay = fakeHitpay
  hitpayDeps.config = { apiBase: 'https://hitpay.test/v1', publicBackendUrl: 'https://api.tinyorder.test' }
  notifyDeps.telegram = async (_t, _c, text) => { telegrams.push(text) }
  notifyDeps.email = (async (to: string, subject: string, body: { text: string }) => { emails.push({ to, subject, text: body.text }) }) as any
})
afterAll(() => {
  Object.assign(hitpayDeps, realHitpay)
  Object.assign(notifyDeps, realNotify)
})

let n = 0
async function connectedShopWithOrder(status = 'pending_payment') {
  n += 1
  const owner = await makeUser(`hitpay-alert-${n}@example.com`, 'password123')
  const { data } = await owner.auth.getSession()
  const merchantId = await seedMerchant({ slug: `hitpay-alert-${n}`, owner_id: data.session!.user.id })
  await svc().from('merchant_secrets').upsert({
    merchant_id: merchantId, tg_token: 'TG', tg_chat_id: '1',
    hitpay_api_key: 'k', hitpay_webhook_id: 'wh', hitpay_webhook_token: `tok_${crypto.randomUUID().replace(/-/g, '')}`,
  })
  await svc().from('merchants').update({ hitpay_connected: true }).eq('id', merchantId)
  const { data: o } = await svc().from('orders').insert({
    merchant_id: merchantId, order_number: `HA-${crypto.randomUUID().slice(0, 8)}`, status,
    customer_name: 'Ah Meng', customer_wa: '60123456789', total: 10, currency: 'MYR', items: [],
  }).select('id, order_number').single()
  return { merchantId, orderId: o!.id as string, orderNumber: o!.order_number as string }
}

const notify = (merchantId: string, orderNumber: string) => app.request('/api/notify/order', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ merchantId, orderNumber }),
})

describe('HitPay merchant alerts', () => {
  it('holds the merchant alert when the order is placed', async () => {
    const s = await connectedShopWithOrder()
    const res = await notify(s.merchantId, s.orderNumber)
    expect(res.status).toBe(200)
    expect(telegrams).toEqual([])
    expect(emails.filter(e => e.subject.includes('New order'))).toEqual([])
  })

  it('sends the alert once, with the paid banner, after the payment', async () => {
    const s = await connectedShopWithOrder()
    await notify(s.merchantId, s.orderNumber)
    await app.request(`/api/orders/${s.orderId}/hitpay-qr`, { method: 'POST' })
    paid.add(s.orderId)
    await app.request(`/api/orders/${s.orderId}/hitpay-status`)
    await app.request(`/api/orders/${s.orderId}/hitpay-status`)
    expect(telegrams).toHaveLength(1)
    expect(telegrams[0].startsWith('✅ Paid by DuitNow (HitPay)')).toBe(true)
    const merchantMails = emails.filter(e => e.subject.includes('New order'))
    expect(merchantMails).toHaveLength(1)
    expect(merchantMails[0].subject.startsWith('Paid: ')).toBe(true)
  })

  it('sends the refund alert for a payment on a cancelled order', async () => {
    const s = await connectedShopWithOrder()
    await app.request(`/api/orders/${s.orderId}/hitpay-qr`, { method: 'POST' })
    await svc().from('orders').update({ status: 'cancelled' }).eq('id', s.orderId)
    paid.add(s.orderId)
    await app.request(`/api/orders/${s.orderId}/hitpay-status`)
    expect(telegrams[0]).toContain('Refund them in your HitPay dashboard')
    expect(emails.some(e => e.subject.startsWith('Refund needed: '))).toBe(true)
  })

  it('does not hold the alert for a shop that is not connected', async () => {
    const s = await connectedShopWithOrder('new')
    await svc().from('merchants').update({ hitpay_connected: false }).eq('id', s.merchantId)
    await notify(s.merchantId, s.orderNumber)
    expect(telegrams).toHaveLength(1)
  })
})
