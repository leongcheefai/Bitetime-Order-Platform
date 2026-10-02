// The HitPay REST calls (spec: docs/superpowers/specs/2026-10-02-hitpay-duitnow-qr-design.md).
//
// Every call is made with the MERCHANT's own key: TinyOrder never holds money and has no HitPay
// account of its own in this flow. The key and the API base are parameters, never read from
// env.ts, and this module imports nothing from supabase.ts or db.ts — the same posture as the
// Claude adapters — so a unit test drives it with a fake fetch.
//
// Two failure classes, and the routes treat them differently: a REJECTED key is the merchant's
// error to fix (400 at connect), anything else is HitPay being unreachable (502, try again).

export class HitpayKeyRejected extends Error {}
export class HitpayUnavailable extends Error {}

export interface RemotePaymentRequest {
  id: string
  status: string
  amount: string
  currency: string
  referenceNumber: string | null
}

export interface Hitpay {
  registerWebhook(apiBase: string, apiKey: string, url: string): Promise<{ id: string }>
  removeWebhook(apiBase: string, apiKey: string, webhookId: string): Promise<void>
  createQr(
    apiBase: string,
    apiKey: string,
    input: { amount: string; currency: string; reference: string; expiresAfterMinutes: number },
  ): Promise<{ id: string; qrPayload: string }>
  getPaymentRequest(apiBase: string, apiKey: string, id: string): Promise<RemotePaymentRequest>
}

export function createHitpay(fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Hitpay {
  async function call(apiBase: string, apiKey: string, path: string, init: { method: string; body?: string; contentType?: string }) {
    const headers: Record<string, string> = { 'X-BUSINESS-API-KEY': apiKey, 'X-Requested-With': 'XMLHttpRequest' }
    if (init.contentType) headers['Content-Type'] = init.contentType
    let res: Response
    try {
      res = await fetchImpl(`${apiBase.replace(/\/$/, '')}${path}`, {
        method: init.method,
        headers,
        body: init.body,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      throw new HitpayUnavailable(`HitPay ${init.method} ${path} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (res.status === 401 || res.status === 403) throw new HitpayKeyRejected(`HitPay refused the key (${res.status})`)
    if (!res.ok) throw new HitpayUnavailable(`HitPay ${init.method} ${path} answered ${res.status}`)
    return (await res.json().catch(() => ({}))) as any
  }

  return {
    async registerWebhook(apiBase, apiKey, url) {
      const body = JSON.stringify({ name: 'TinyOrder', url, event_types: ['charge.created', 'charge.updated'] })
      const r = await call(apiBase, apiKey, '/webhook-events', { method: 'POST', body, contentType: 'application/json' })
      if (!r?.id) throw new HitpayUnavailable('HitPay returned no webhook id')
      return { id: String(r.id) }
    },
    async removeWebhook(apiBase, apiKey, webhookId) {
      await call(apiBase, apiKey, `/webhook-events/${encodeURIComponent(webhookId)}`, { method: 'DELETE' })
    },
    async createQr(apiBase, apiKey, input) {
      const form = new URLSearchParams()
      form.set('amount', input.amount)
      form.set('currency', input.currency)
      form.append('payment_methods[]', 'duitnow')
      form.set('generate_qr', 'true')
      form.set('expires_after', `${input.expiresAfterMinutes} minutes`)
      form.set('reference_number', input.reference)
      const r = await call(apiBase, apiKey, '/payment-requests', {
        method: 'POST', body: form.toString(), contentType: 'application/x-www-form-urlencoded',
      })
      const qr = r?.qr_code_data?.qr_code
      if (!r?.id || typeof qr !== 'string' || !qr) throw new HitpayUnavailable('HitPay returned no QR payload')
      return { id: String(r.id), qrPayload: qr }
    },
    async getPaymentRequest(apiBase, apiKey, id) {
      const r = await call(apiBase, apiKey, `/payment-requests/${encodeURIComponent(id)}`, { method: 'GET' })
      return {
        id: String(r?.id ?? id),
        status: String(r?.status ?? ''),
        amount: String(r?.amount ?? ''),
        currency: String(r?.currency ?? ''),
        referenceNumber: r?.reference_number == null ? null : String(r.reference_number),
      }
    },
  }
}
