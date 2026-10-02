// tests/api/hitpay-connect.test.ts
// Connect / disconnect a shop's own HitPay account. HitPay itself is faked through the exported
// `hitpayDeps` seam; Postgres is real, because what this suite proves is what lands in
// merchant_secrets and merchants — and that the key never comes back out.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { app, hitpayDeps } from '../../src/app.js'
import { HitpayKeyRejected, HitpayUnavailable, type Hitpay } from '../../src/hitpay.js'
import { makeUser, seedMerchant, seedProduct, serviceClient } from '../rls/helpers.js'

const realDeps = { ...hitpayDeps }
const calls: string[] = []

function fakeHitpay(over: Partial<Hitpay> = {}): Hitpay {
  return {
    async registerWebhook(_b, key, url) { calls.push(`register ${key} ${url}`); return { id: `wh_${calls.length}` } },
    async removeWebhook(_b, key, id) { calls.push(`remove ${key} ${id}`) },
    async createQr() { throw new Error('not used') },
    async getPaymentRequest() { throw new Error('not used') },
    ...over,
  }
}

beforeEach(() => {
  calls.length = 0
  hitpayDeps.hitpay = fakeHitpay()
  hitpayDeps.config = { apiBase: 'https://hitpay.test/v1', publicBackendUrl: 'https://api.tinyorder.test' }
})
afterAll(() => Object.assign(hitpayDeps, realDeps))

let n = 0
async function ownerShop(currency = 'MYR') {
  n += 1
  const owner = await makeUser(`hitpay-connect-${n}@example.com`, 'password123')
  const { data } = await owner.auth.getSession()
  const merchantId = await seedMerchant({ slug: `hitpay-connect-${n}`, owner_id: data.session!.user.id })
  if (currency !== 'MYR') await serviceClient().from('merchants').update({ currency }).eq('id', merchantId)
  return { merchantId, token: data.session!.access_token }
}

const call = (method: string, path: string, token: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })

describe('HitPay connection', () => {
  it('registers the webhook with the key, stores it, and flags the shop', async () => {
    const { merchantId, token } = await ownerShop()
    const res = await call('PUT', `/api/merchants/${merchantId}/hitpay`, token, { apiKey: '  live_key_9876  ' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ connected: true, keyLast4: '9876' })
    expect(calls[0]).toMatch(/^register live_key_9876 https:\/\/api\.tinyorder\.test\/api\/hitpay\/webhook\/[A-Za-z0-9_-]{32,}$/)

    const { data: m } = await serviceClient().from('merchants').select('hitpay_connected').eq('id', merchantId).single()
    expect(m!.hitpay_connected).toBe(true)
    const { data: s } = await serviceClient().from('merchant_secrets')
      .select('hitpay_api_key, hitpay_webhook_id, hitpay_webhook_token').eq('merchant_id', merchantId).single()
    expect(s!.hitpay_api_key).toBe('live_key_9876')
    expect(s!.hitpay_webhook_id).toBe('wh_1')
  })

  it('never returns the key from any read route', async () => {
    const { merchantId, token } = await ownerShop()
    await call('PUT', `/api/merchants/${merchantId}/hitpay`, token, { apiKey: 'secret_key_ABCD' })
    for (const path of [`/api/merchants/${merchantId}/hitpay`, `/api/merchants/${merchantId}/secret`]) {
      const text = await (await call('GET', path, token)).text()
      expect(text).not.toContain('secret_key_ABCD')
    }
    expect(await (await call('GET', `/api/merchants/${merchantId}/hitpay`, token)).json())
      .toEqual({ connected: true, keyLast4: 'ABCD' })
  })

  it('answers 400 invalid_key and stores nothing when HitPay rejects the key', async () => {
    hitpayDeps.hitpay = fakeHitpay({ async registerWebhook() { throw new HitpayKeyRejected('no') } })
    const { merchantId, token } = await ownerShop()
    const res = await call('PUT', `/api/merchants/${merchantId}/hitpay`, token, { apiKey: 'bad' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('invalid_key')
    const { data: m } = await serviceClient().from('merchants').select('hitpay_connected').eq('id', merchantId).single()
    expect(m!.hitpay_connected).toBe(false)
  })

  it('answers 502 gateway_unavailable when HitPay is down', async () => {
    hitpayDeps.hitpay = fakeHitpay({ async registerWebhook() { throw new HitpayUnavailable('down') } })
    const { merchantId, token } = await ownerShop()
    const res = await call('PUT', `/api/merchants/${merchantId}/hitpay`, token, { apiKey: 'k' })
    expect(res.status).toBe(502)
    expect(((await res.json()) as any).error).toBe('gateway_unavailable')
  })

  it('refuses a shop whose currency is not MYR', async () => {
    const { merchantId, token } = await ownerShop('SGD')
    const res = await call('PUT', `/api/merchants/${merchantId}/hitpay`, token, { apiKey: 'k' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('currency_not_supported')
    expect(calls).toEqual([])
  })

  it('answers 503 when the platform has no HitPay config', async () => {
    hitpayDeps.config = { apiBase: '', publicBackendUrl: '' }
    const { merchantId, token } = await ownerShop()
    expect((await call('PUT', `/api/merchants/${merchantId}/hitpay`, token, { apiKey: 'k' })).status).toBe(503)
  })

  it('refuses an empty key', async () => {
    const { merchantId, token } = await ownerShop()
    expect((await call('PUT', `/api/merchants/${merchantId}/hitpay`, token, { apiKey: '   ' })).status).toBe(400)
  })

  it('replaces the old webhook on a second connect', async () => {
    const { merchantId, token } = await ownerShop()
    await call('PUT', `/api/merchants/${merchantId}/hitpay`, token, { apiKey: 'first_1111' })
    await call('PUT', `/api/merchants/${merchantId}/hitpay`, token, { apiKey: 'second_2222' })
    expect(calls).toContain('remove first_1111 wh_1')
  })

  it('disconnects: removes the webhook, clears the secret, unflags the shop', async () => {
    const { merchantId, token } = await ownerShop()
    await call('PUT', `/api/merchants/${merchantId}/hitpay`, token, { apiKey: 'key_5555' })
    const res = await call('DELETE', `/api/merchants/${merchantId}/hitpay`, token)
    expect(await res.json()).toEqual({ connected: false, keyLast4: null })
    expect(calls).toContain('remove key_5555 wh_1')
    const { data: s } = await serviceClient().from('merchant_secrets')
      .select('hitpay_api_key, hitpay_webhook_token').eq('merchant_id', merchantId).single()
    expect(s).toEqual({ hitpay_api_key: null, hitpay_webhook_token: null })
  })

  it('disconnects even when HitPay cannot remove the webhook', async () => {
    const { merchantId, token } = await ownerShop()
    await call('PUT', `/api/merchants/${merchantId}/hitpay`, token, { apiKey: 'key_6666' })
    hitpayDeps.hitpay = fakeHitpay({ async removeWebhook() { throw new HitpayUnavailable('down') } })
    expect((await call('DELETE', `/api/merchants/${merchantId}/hitpay`, token)).status).toBe(200)
  })

  it("refuses another merchant's shop", async () => {
    const a = await ownerShop()
    const b = await ownerShop()
    expect((await call('PUT', `/api/merchants/${a.merchantId}/hitpay`, b.token, { apiKey: 'k' })).status).toBe(403)
  })

  it('makes a connected shop take orders as pending_payment, with no static payment info', async () => {
    const { merchantId } = await ownerShop()
    await serviceClient().from('merchants').update({ hitpay_connected: true }).eq('id', merchantId)
    const productId = await seedProduct({ merchant_id: merchantId, name: 'Cookie', price: 10 })
    const res = await app.request('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchantId, customerName: 'Ah Meng', customerWa: '60123456789', mode: 'pickup',
        cart: [{ productId, qty: 1, selections: [] }], quotedTotal: 10,
        fulfilDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
      }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).status).toBe('pending_payment')
  })
})
