// The ONE function both confirmation paths call — the webhook signal and the browser's poll — so
// the two cannot drift apart (spec 2026-10-02 → "confirmHitpayPayment").
//
// It trusts nothing it was handed except the row it was given: it asks HitPay with the key of the
// shop that OWNS that row, judges the answer with the pure rules, and settles in one transaction.
// The alert runs only after the commit, and its failure is logged, never thrown: a Telegram
// outage must not look like an unpaid order.
import type { Hitpay } from './hitpay.js'
import { judgePayment } from './hitpayPayment.js'
import {
  closeOrderPayment, readHitpayConnection, settleOrderPayment,
  type OrderPaymentRow, type SettleOutcome,
} from './hitpayPaymentDb.js'

export type ConfirmOutcome = SettleOutcome | 'pending' | 'closed' | 'mismatch' | 'unavailable' | 'disconnected'

/** HitPay holds a completed payment for this row, whatever the order's status. */
export function isSettled(o: ConfirmOutcome): boolean {
  return o === 'paid' || o === 'paid_after_cancel' || o === 'recorded' || o === 'already'
}

export interface PaymentAlert {
  merchantId: string
  orderNumber: string
  /** `gateway_failed`: the customer could not get a QR, so the held alert goes out unpaid. */
  outcome: 'paid' | 'paid_after_cancel' | 'gateway_failed'
}

export interface ConfirmDeps {
  hitpay: Hitpay
  apiBase: string
  alert: (a: PaymentAlert) => Promise<void>
}

export async function confirmHitpayPayment(deps: ConfirmDeps, row: OrderPaymentRow): Promise<ConfirmOutcome> {
  if (row.status === 'completed') return 'already'
  const conn = await readHitpayConnection(row.merchantId)
  if (!conn) return 'disconnected'

  let remote
  try {
    remote = await deps.hitpay.getPaymentRequest(deps.apiBase, conn.apiKey, row.gatewayRequestId)
  } catch (e) {
    console.error(`HitPay status read failed for ${row.gatewayRequestId}:`, e instanceof Error ? e.message : String(e))
    return 'unavailable'
  }

  const verdict = judgePayment(remote, { amount: row.amount, currency: row.currency, orderId: row.orderId })
  if (verdict.kind === 'pending') return 'pending'
  if (verdict.kind === 'closed') {
    await closeOrderPayment(row.id, row.merchantId, verdict.status)
    return 'closed'
  }
  if (verdict.kind === 'mismatch') {
    console.error(`HitPay payment ${row.gatewayRequestId} does not match order ${row.orderId}: ${verdict.reason}`)
    return 'mismatch'
  }

  const settled = await settleOrderPayment(row.id, row.merchantId)
  if (settled.outcome === 'paid' || settled.outcome === 'paid_after_cancel') {
    await deps.alert({ merchantId: row.merchantId, orderNumber: settled.orderNumber, outcome: settled.outcome })
      .catch(e => console.error('HitPay payment alert failed:', e?.message ?? e))
  }
  return settled.outcome
}
