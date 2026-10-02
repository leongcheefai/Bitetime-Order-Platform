// tests/api/hitpay-payment.test.ts
// The customer's QR, the poll, the webhook, and the one transaction that settles an order. HitPay
// is faked through `hitpayDeps`; Postgres is real, because the properties here are row locks,
// a partial unique index, and tenancy on an RLS-exempt connection.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { app, hitpayDeps, hitpayAlertDeps } from '../../src/app.js'
import type { Hitpay, RemotePaymentRequest } from '../../src/hitpay.js'
import type { PaymentAlert } from '../../src/hitpayConfirm.js'
import { makeUser, seedMerchant, serviceClient } from '../rls/helpers.js'

const svc = () => serviceClient()
const realDeps = { ...hitpayDeps }
const realAlert = hitpayAlertDeps.alert
const alerts: PaymentAlert[] = []
let created = 0
let remoteStatus: Record<string, Partial<RemotePaymentRequest>> = {}
let remoteOrder: Record<string, string> = {}

function fakeHitpay(): Hitpay {
  return {
    async registerWebhook() { return { id: 'wh' } },
    async removeWebhook() {},
    async createQr(_b, _k, input) {
      created += 1
      const id = `pr_${crypto.randomUUID()}`
      remoteOrder[id] = input.reference
      return { id, qrPayload: `000201-${id}` }
    },
    async getPaymentRequest(_b, _k, id) {
      return {
        id, status: 'pending', amount: '10.00', currency: 'myr', referenceNumber: remoteOrder[id] ?? null,
        ...remoteStatus[id],
      }
    },
  }
}

beforeEach(() => {
  created = 0
  remoteStatus = {}
  remoteOrder = {}
  alerts.length = 0
  hitpayDeps.hitpay = fakeHitpay()
  hitpayDeps.config = { apiBase: 'https://hitpay.test/v1', publicBackendUrl: 'https://api.tinyorder.test' }
  hitpayAlertDeps.alert = async (a) => { alerts.push(a) }
})
afterAll(() => {
  Object.assign(hitpayDeps, realDeps)
  hitpayAlertDeps.alert = realAlert
})

let n = 0
async function connectedShop() {
  n += 1
  const owner = await makeUser(`hitpay-pay-${n}@example.com`, 'password123')
  const { data } = await owner.auth.getSession()
  const merchantId = await seedMerchant({ slug: `hitpay-pay-${n}`, owner_id: data.session!.user.id })
  const token = `tok_${crypto.randomUUID().replace(/-/g, '')}`
  await svc().from('merchant_secrets').upsert({
    merchant_id: merchantId, hitpay_api_key: `key_${n}`, hitpay_webhook_id: 'wh', hitpay_webhook_token: token,
  })
  await svc().from('merchants').update({ hitpay_connected: true }).eq('id', merchantId)
  return { merchantId, token }
}

async function order(merchantId: string, status = 'pending_payment') {
  const { data, error } = await svc().from('orders').insert({
    merchant_id: merchantId, order_number: `HP-${crypto.randomUUID().slice(0, 8)}`, status,
    customer_name: 'Ah Meng', customer_wa: '60123456789', total: 10, currency: 'MYR',
  }).select('id, order_number').single()
  if (error) throw new Error(error.message)
  return data as { id: string; order_number: string }
}

// A fresh client address for each request, as tests/api/invoice.test.ts does: the public order
// routes carry an IP window, and every request here would otherwise share one address.
let ipCounter = 0
const ipHeader = () => {
  ipCounter += 1
  return { 'x-forwarded-for': `10.${Math.floor(ipCounter / 250)}.${ipCounter % 250}.2` }
}
const postQr = (orderId: string) => app.request(`/api/orders/${orderId}/hitpay-qr`, { method: 'POST', headers: ipHeader() })
const getStatus = (orderId: string) => app.request(`/api/orders/${orderId}/hitpay-status`, { headers: ipHeader() })
const signal = (token: string, body: unknown) => app.request(`/api/hitpay/webhook/${token}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
const payment = async (orderId: string) =>
  (await svc().from('order_payments').select('*').eq('order_id', orderId).order('created_at')).data ?? []
const orderStatus = async (orderId: string) =>
  (await svc().from('orders').select('status').eq('id', orderId).single()).data!.status

describe('POST /api/orders/:id/hitpay-qr', () => {
  it('creates one QR for the order total and returns the same QR on a second call', async () => {
    const { merchantId } = await connectedShop()
    const o = await order(merchantId)
    const first = (await (await postQr(o.id)).json()) as any
    expect(first).toMatchObject({ status: 'live', amount: '10.00', currency: 'MYR' })
    expect(first.qrPayload).toMatch(/^000201-pr_/)
    const second = (await (await postQr(o.id)).json()) as any
    expect(second.qrPayload).toBe(first.qrPayload)
    expect(created).toBe(1)
  })

  it('makes only one live QR for two requests at the same time', async () => {
    const { merchantId } = await connectedShop()
    const o = await order(merchantId)
    const [a, b] = await Promise.all([postQr(o.id), postQr(o.id)])
    const [ja, jb] = [await a.json() as any, await b.json() as any]
    expect(ja.qrPayload).toBe(jb.qrPayload)
    expect((await payment(o.id)).filter(r => r.status === 'pending')).toHaveLength(1)
  })

  it('checks the expired QR with HitPay before it makes a new one', async () => {
    const { merchantId } = await connectedShop()
    const o = await order(merchantId)
    await postQr(o.id)
    const [row] = await payment(o.id)
    await svc().from('order_payments').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', row.id)
    remoteStatus[row.gateway_request_id] = { status: 'completed' }
    expect(await (await postQr(o.id)).json() as any).toEqual({ status: 'completed' })
    expect(created).toBe(1)
    expect(await orderStatus(o.id)).toBe('new')
  })

  it('makes a new QR after the old one expired unpaid', async () => {
    const { merchantId } = await connectedShop()
    const o = await order(merchantId)
    await postQr(o.id)
    const [row] = await payment(o.id)
    await svc().from('order_payments').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', row.id)
    remoteStatus[row.gateway_request_id] = { status: 'expired' }
    expect((await (await postQr(o.id)).json() as any).status).toBe('live')
    expect(created).toBe(2)
    expect((await payment(o.id)).map(r => r.status)).toEqual(['expired', 'pending'])
  })

  it('answers 409 not_payable for an order that is not pending_payment, or a shop not connected', async () => {
    const { merchantId } = await connectedShop()
    expect((await postQr((await order(merchantId, 'new')).id)).status).toBe(409)
    const o = await order(merchantId)
    await svc().from('merchants').update({ hitpay_connected: false }).eq('id', merchantId)
    expect((await postQr(o.id)).status).toBe(409)
  })

  it('answers 502 when HitPay cannot make the QR', async () => {
    hitpayDeps.hitpay = { ...fakeHitpay(), async createQr() { throw new Error('down') } }
    const { merchantId } = await connectedShop()
    const res = await postQr((await order(merchantId)).id)
    expect(res.status).toBe(502)
    expect((await res.json() as any).error).toBe('gateway_unavailable')
  })

  it('answers 404 for an unknown or malformed order id', async () => {
    expect((await postQr(crypto.randomUUID())).status).toBe(404)
    expect((await postQr('nope')).status).toBe(404)
  })
})

describe('confirmation', () => {
  it('a poll moves a paid order to new, logs it, and alerts once', async () => {
    const { merchantId } = await connectedShop()
    const o = await order(merchantId)
    await postQr(o.id)
    const [row] = await payment(o.id)
    remoteStatus[row.gateway_request_id] = { status: 'completed' }

    expect(await (await getStatus(o.id)).json() as any).toMatchObject({ payment: 'completed', orderStatus: 'new' })
    await getStatus(o.id)
    expect(alerts).toEqual([{ merchantId, orderNumber: o.order_number, outcome: 'paid' }])
    const { data: events } = await svc().from('order_events').select('kind, actor_kind').eq('order_id', o.id).order('id')
    expect(events).toEqual([
      { kind: 'payment_confirmed', actor_kind: 'system' },
      { kind: 'status_changed', actor_kind: 'system' },
    ])
  })

  it('a webhook signal does the same, and a repeat signal does nothing', async () => {
    const { merchantId, token } = await connectedShop()
    const o = await order(merchantId)
    await postQr(o.id)
    const [row] = await payment(o.id)
    remoteStatus[row.gateway_request_id] = { status: 'completed' }
    expect((await signal(token, { id: 'ch_1', payment_request_id: row.gateway_request_id })).status).toBe(200)
    expect((await signal(token, { id: 'ch_1', payment_request_id: row.gateway_request_id })).status).toBe(200)
    expect(await orderStatus(o.id)).toBe('new')
    expect(alerts).toHaveLength(1)
  })

  it('ignores a request id that belongs to a different shop', async () => {
    const x = await connectedShop()
    const y = await connectedShop()
    const oy = await order(y.merchantId)
    await postQr(oy.id)
    const [row] = await payment(oy.id)
    remoteStatus[row.gateway_request_id] = { status: 'completed' }
    expect((await signal(x.token, { payment_request_id: row.gateway_request_id })).status).toBe(200)
    expect(await orderStatus(oy.id)).toBe('pending_payment')
    expect(alerts).toEqual([])
  })

  it('answers 200 to an unknown token and to a body with no request id', async () => {
    expect((await signal('unknown-token', { payment_request_id: 'pr_x' })).status).toBe(200)
    const { token } = await connectedShop()
    expect((await signal(token, { hello: 'world' })).status).toBe(200)
  })

  it('refuses a completed request whose amount does not agree', async () => {
    const { merchantId } = await connectedShop()
    const o = await order(merchantId)
    await postQr(o.id)
    const [row] = await payment(o.id)
    remoteStatus[row.gateway_request_id] = { status: 'completed', amount: '1.00' }
    expect((await (await getStatus(o.id)).json() as any).orderStatus).toBe('pending_payment')
    expect(alerts).toEqual([])
  })

  it('keeps a cancelled order cancelled and records the payment for a refund', async () => {
    const { merchantId } = await connectedShop()
    const o = await order(merchantId)
    await postQr(o.id)
    const [row] = await payment(o.id)
    await svc().from('orders').update({ status: 'cancelled' }).eq('id', o.id)
    remoteStatus[row.gateway_request_id] = { status: 'completed' }
    await getStatus(o.id)
    expect(await orderStatus(o.id)).toBe('cancelled')
    expect(alerts).toEqual([{ merchantId, orderNumber: o.order_number, outcome: 'paid_after_cancel' }])
    const { data: events } = await svc().from('order_events').select('kind').eq('order_id', o.id)
    expect(events).toEqual([{ kind: 'payment_after_cancel' }])
  })

  it('does nothing after the shop disconnects', async () => {
    const { merchantId } = await connectedShop()
    const o = await order(merchantId)
    await postQr(o.id)
    const [row] = await payment(o.id)
    remoteStatus[row.gateway_request_id] = { status: 'completed' }
    await svc().from('merchant_secrets').update({ hitpay_api_key: null, hitpay_webhook_id: null, hitpay_webhook_token: null }).eq('merchant_id', merchantId)
    const res = await getStatus(o.id)
    expect(res.status).toBe(200)
    expect(await orderStatus(o.id)).toBe('pending_payment')
  })

  it("a webhook still confirms after the screen's local expiry", async () => {
    const { merchantId, token } = await connectedShop()
    const o = await order(merchantId)
    await postQr(o.id)
    const [row] = await payment(o.id)
    await svc().from('order_payments').update({ status: 'expired' }).eq('id', row.id)
    remoteStatus[row.gateway_request_id] = { status: 'completed' }
    await signal(token, { payment_request_id: row.gateway_request_id })
    expect(await orderStatus(o.id)).toBe('new')
  })
})
