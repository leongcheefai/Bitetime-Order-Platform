// The pure half of the HitPay payment flow: no I/O, so `pnpm test` reaches all of it.
// `hitpayPaymentDb.ts` holds the SQL and `hitpayConfirm.ts` joins the two.
import { randomBytes } from 'node:crypto'
import type { RemotePaymentRequest } from './hitpay.js'
import type { AlertBanner } from './orderNotice.js'

/** How long one QR stays valid. HitPay gets the same figure as `expires_after`. */
export const QR_LIFETIME_MINUTES = 15

export type PaymentRowStatus = 'pending' | 'completed' | 'expired' | 'failed'

/** A QR the customer can still pay: the row is pending and its time has not run out. */
export function isLive(row: { status: PaymentRowStatus; expiresAt: Date }, now: Date): boolean {
  return row.status === 'pending' && row.expiresAt.getTime() > now.getTime()
}

/** Money as HitPay takes it: a string with exactly two decimals. */
export function moneyString(value: number | string): string {
  return Number(value).toFixed(2)
}

function cents(value: number | string): number {
  return Math.round(Number(value) * 100)
}

export type Verdict =
  | { kind: 'paid' }
  | { kind: 'pending' }
  | { kind: 'closed'; status: 'expired' | 'failed' }
  | { kind: 'mismatch'; reason: string }

/**
 * What HitPay's own answer means for this order. `paid` only when the request is completed AND
 * its amount, currency and reference all agree with what we asked for: a completed request for a
 * different sum or a different order is a fault for a person to look at, never a payment.
 *
 * An unknown status reads as `pending` — it is a status this module has not been taught, and
 * reading it as paid would move an order on a guess.
 */
export function judgePayment(
  remote: RemotePaymentRequest,
  expected: { amount: number | string; currency: string; orderId: string },
): Verdict {
  const status = remote.status.toLowerCase()
  if (status === 'expired') return { kind: 'closed', status: 'expired' }
  if (status === 'failed' || status === 'canceled' || status === 'inactive') return { kind: 'closed', status: 'failed' }
  if (status !== 'completed') return { kind: 'pending' }
  if (cents(remote.amount) !== cents(expected.amount)) {
    return { kind: 'mismatch', reason: `amount ${remote.amount} != ${moneyString(expected.amount)}` }
  }
  if (remote.currency.toLowerCase() !== expected.currency.toLowerCase()) {
    return { kind: 'mismatch', reason: `currency ${remote.currency} != ${expected.currency}` }
  }
  if (remote.referenceNumber !== expected.orderId) {
    return { kind: 'mismatch', reason: `reference ${remote.referenceNumber} != ${expected.orderId}` }
  }
  return { kind: 'paid' }
}

/**
 * The ONE field the backend reads from a webhook body. Everything else in the body is ignored:
 * the payload carries no signature we can check (spec → "Why the trust model is verify by
 * fetch"), so it is a hint about which request to ask HitPay about, and nothing more.
 */
export function readSignalRequestId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const b = body as { payment_request_id?: unknown; payment_request?: { id?: unknown } | null }
  const id = typeof b.payment_request_id === 'string' ? b.payment_request_id
    : typeof b.payment_request?.id === 'string' ? b.payment_request.id
    : null
  return id ? id : null
}

/** The random part of a shop's webhook URL. It names the shop; it is not a credential. */
export function newWebhookToken(): string {
  return randomBytes(24).toString('base64url')
}

export function keyLast4(apiKey: string): string {
  return apiKey.slice(-4)
}

export const PAID_BANNER: AlertBanner = { line: '✅ Paid by DuitNow (HitPay)', subjectPrefix: 'Paid' }

export const PAID_AFTER_CANCEL_BANNER: AlertBanner = {
  line: '⚠️ The customer paid after you cancelled this order. Refund them in your HitPay dashboard.',
  subjectPrefix: 'Refund needed',
}
