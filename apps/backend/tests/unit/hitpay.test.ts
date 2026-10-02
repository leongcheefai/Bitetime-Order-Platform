// tests/unit/hitpay.test.ts
import { describe, it, expect } from 'vitest'
import { createHitpay, HitpayKeyRejected, HitpayUnavailable } from '../../src/hitpay.js'

const BASE = 'https://api.sandbox.hit-pay.com/v1'

function fakeFetch(reply: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = reply(url, init)
    const status = r.status ?? 200
    // A 204 cannot carry a body — the Response constructor refuses one.
    return new Response(status === 204 ? null : JSON.stringify(r.body), { status })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const headersOf = (init: RequestInit) => new Headers(init.headers as ConstructorParameters<typeof Headers>[0])

describe('hitpay adapter', () => {
  it('registers a charge webhook with the merchant key and returns its id', async () => {
    const f = fakeFetch(() => ({ body: { id: 'wh_1', business_id: 'b', name: 'TinyOrder', url: 'u', event_types: [] } }))
    const hp = createHitpay(f.impl)
    expect(await hp.registerWebhook(BASE, 'KEY', 'https://api.example.com/api/hitpay/webhook/tok')).toEqual({ id: 'wh_1' })
    expect(f.calls[0].url).toBe(`${BASE}/webhook-events`)
    expect(f.calls[0].init.method).toBe('POST')
    expect(headersOf(f.calls[0].init).get('X-BUSINESS-API-KEY')).toBe('KEY')
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({
      name: 'TinyOrder',
      url: 'https://api.example.com/api/hitpay/webhook/tok',
      event_types: ['charge.created', 'charge.updated'],
    })
  })

  it('creates a DuitNow QR with form fields and returns the raw payload', async () => {
    const f = fakeFetch(() => ({ body: { id: 'pr_1', status: 'pending', qr_code_data: { qr_code: '000201...', qr_code_expiry: null } } }))
    const hp = createHitpay(f.impl)
    const out = await hp.createQr(BASE, 'KEY', { amount: '26.00', currency: 'myr', reference: 'order-uuid', expiresAfterMinutes: 15 })
    expect(out).toEqual({ id: 'pr_1', qrPayload: '000201...' })
    expect(f.calls[0].url).toBe(`${BASE}/payment-requests`)
    expect(headersOf(f.calls[0].init).get('Content-Type')).toBe('application/x-www-form-urlencoded')
    const form = new URLSearchParams(String(f.calls[0].init.body))
    expect(form.get('amount')).toBe('26.00')
    expect(form.get('currency')).toBe('myr')
    expect(form.getAll('payment_methods[]')).toEqual(['duitnow'])
    expect(form.get('generate_qr')).toBe('true')
    expect(form.get('expires_after')).toBe('15 minutes')
    expect(form.get('reference_number')).toBe('order-uuid')
    expect(form.has('allow_repeated_payments')).toBe(false)
  })

  it('reads a payment request and maps reference_number', async () => {
    const f = fakeFetch(() => ({ body: { id: 'pr_1', status: 'completed', amount: '26.00', currency: 'myr', reference_number: 'order-uuid', payments: [] } }))
    const hp = createHitpay(f.impl)
    expect(await hp.getPaymentRequest(BASE, 'KEY', 'pr_1')).toEqual({
      id: 'pr_1', status: 'completed', amount: '26.00', currency: 'myr', referenceNumber: 'order-uuid',
    })
    expect(f.calls[0].url).toBe(`${BASE}/payment-requests/pr_1`)
    expect(f.calls[0].init.method).toBe('GET')
  })

  it('maps 401 and 403 to HitpayKeyRejected', async () => {
    for (const status of [401, 403]) {
      const hp = createHitpay(fakeFetch(() => ({ status, body: { message: 'Unauthenticated.' } })).impl)
      await expect(hp.registerWebhook(BASE, 'BAD', 'https://x')).rejects.toBeInstanceOf(HitpayKeyRejected)
    }
  })

  it('maps a 5xx, a 422 and a network failure to HitpayUnavailable', async () => {
    const hp5 = createHitpay(fakeFetch(() => ({ status: 503, body: {} })).impl)
    await expect(hp5.getPaymentRequest(BASE, 'KEY', 'pr')).rejects.toBeInstanceOf(HitpayUnavailable)
    const hp422 = createHitpay(fakeFetch(() => ({ status: 422, body: { message: 'bad' } })).impl)
    await expect(hp422.createQr(BASE, 'KEY', { amount: '1.00', currency: 'myr', reference: 'r', expiresAfterMinutes: 15 }))
      .rejects.toBeInstanceOf(HitpayUnavailable)
    const broken = createHitpay((async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch)
    await expect(broken.getPaymentRequest(BASE, 'KEY', 'pr')).rejects.toBeInstanceOf(HitpayUnavailable)
  })

  it('refuses a QR response with no payload', async () => {
    const hp = createHitpay(fakeFetch(() => ({ body: { id: 'pr_1', status: 'pending', qr_code_data: null } })).impl)
    await expect(hp.createQr(BASE, 'KEY', { amount: '1.00', currency: 'myr', reference: 'r', expiresAfterMinutes: 15 }))
      .rejects.toBeInstanceOf(HitpayUnavailable)
  })

  it('removes a webhook by id', async () => {
    const f = fakeFetch(() => ({ status: 204, body: {} }))
    await createHitpay(f.impl).removeWebhook(BASE, 'KEY', 'wh_1')
    expect(f.calls[0].url).toBe(`${BASE}/webhook-events/wh_1`)
    expect(f.calls[0].init.method).toBe('DELETE')
  })
})
