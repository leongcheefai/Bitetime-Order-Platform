// The HitPay flow's SQL (spec 2026-10-02). `db.ts` is RLS-EXEMPT, so every statement here names
// the merchant it acts for: on this path, which shop a row belongs to is a TypeScript rule, not a
// Postgres one. The pure half is hitpayPayment.ts.
import { sql, withTransaction } from './db.js'
import type { PaymentRowStatus } from './hitpayPayment.js'
import { recordOrderEvents, SYSTEM_ACTOR } from './orderEventsDb.js'

export interface HitpayConnection {
  apiKey: string
  webhookId: string
  token: string
}

export async function readHitpayConnection(merchantId: string): Promise<HitpayConnection | null> {
  const rows = await sql<{ hitpay_api_key: string | null; hitpay_webhook_id: string | null; hitpay_webhook_token: string | null }[]>`
    select hitpay_api_key, hitpay_webhook_id, hitpay_webhook_token
    from merchant_secrets where merchant_id = ${merchantId}
  `
  const r = rows[0]
  if (!r?.hitpay_api_key || !r.hitpay_webhook_id || !r.hitpay_webhook_token) return null
  return { apiKey: r.hitpay_api_key, webhookId: r.hitpay_webhook_id, token: r.hitpay_webhook_token }
}

/** The secret row and the shop's flag move together, or not at all. */
export async function saveHitpayConnection(merchantId: string, c: HitpayConnection): Promise<void> {
  await withTransaction(async (tx) => {
    await tx`
      insert into merchant_secrets (merchant_id, hitpay_api_key, hitpay_webhook_id, hitpay_webhook_token)
      values (${merchantId}, ${c.apiKey}, ${c.webhookId}, ${c.token})
      on conflict (merchant_id) do update set
        hitpay_api_key = excluded.hitpay_api_key,
        hitpay_webhook_id = excluded.hitpay_webhook_id,
        hitpay_webhook_token = excluded.hitpay_webhook_token
    `
    await tx`update merchants set hitpay_connected = true where id = ${merchantId}`
  })
}

export async function clearHitpayConnection(merchantId: string): Promise<void> {
  await withTransaction(async (tx) => {
    await tx`
      update merchant_secrets
      set hitpay_api_key = null, hitpay_webhook_id = null, hitpay_webhook_token = null
      where merchant_id = ${merchantId}
    `
    await tx`update merchants set hitpay_connected = false where id = ${merchantId}`
  })
}

/** The shop a webhook URL names, or null. */
export async function merchantByWebhookToken(token: string): Promise<string | null> {
  const rows = await sql<{ merchant_id: string }[]>`
    select merchant_id from merchant_secrets where hitpay_webhook_token = ${token}
  `
  return rows[0]?.merchant_id ?? null
}

export interface OrderPaymentRow {
  id: string
  orderId: string
  merchantId: string
  gateway: 'hitpay'
  gatewayRequestId: string
  qrPayload: string
  amount: string
  currency: string
  status: PaymentRowStatus
  expiresAt: Date
  paidAt: Date | null
}

type PaymentDbRow = {
  id: string; order_id: string; merchant_id: string; gateway: 'hitpay'; gateway_request_id: string
  qr_payload: string; amount: string; currency: string; status: PaymentRowStatus; expires_at: Date; paid_at: Date | null
}

function toRow(r: PaymentDbRow): OrderPaymentRow {
  return {
    id: r.id, orderId: r.order_id, merchantId: r.merchant_id, gateway: r.gateway,
    gatewayRequestId: r.gateway_request_id, qrPayload: r.qr_payload, amount: String(r.amount),
    currency: r.currency, status: r.status, expiresAt: r.expires_at, paidAt: r.paid_at,
  }
}

export interface PayableOrder {
  id: string
  merchantId: string
  status: string
  total: string
  currency: string
  hitpayConnected: boolean
}

/**
 * The order the public QR routes act on, with its shop's flag. `null` for a missing OR malformed
 * id — the same `22P02` carve-out as `orderMerchantId` in orders.ts, and only that one: any other
 * error is a real database failure and is rethrown.
 */
export async function payableOrder(orderId: string): Promise<PayableOrder | null> {
  try {
    const rows = await sql<{ id: string; merchant_id: string; status: string | null; total: string; currency: string | null; hitpay_connected: boolean }[]>`
      select o.id, o.merchant_id, o.status, o.total, o.currency, m.hitpay_connected
      from orders o join merchants m on m.id = o.merchant_id
      where o.id = ${orderId}
    `
    const r = rows[0]
    if (!r) return null
    return {
      id: r.id, merchantId: r.merchant_id, status: r.status ?? 'new', total: String(r.total),
      currency: r.currency ?? 'MYR', hitpayConnected: r.hitpay_connected,
    }
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: string }).code === '22P02') return null
    throw err
  }
}

const PAYMENT_COLUMNS = sql`id, order_id, merchant_id, gateway, gateway_request_id, qr_payload, amount, currency, status, expires_at, paid_at`

export async function latestOrderPayment(orderId: string, merchantId: string): Promise<OrderPaymentRow | null> {
  const rows = await sql<PaymentDbRow[]>`
    select ${PAYMENT_COLUMNS} from order_payments
    where order_id = ${orderId} and merchant_id = ${merchantId}
    order by created_at desc limit 1
  `
  return rows[0] ? toRow(rows[0]) : null
}

export async function orderPaymentByRequestId(requestId: string, merchantId: string): Promise<OrderPaymentRow | null> {
  const rows = await sql<PaymentDbRow[]>`
    select ${PAYMENT_COLUMNS} from order_payments
    where gateway_request_id = ${requestId} and merchant_id = ${merchantId}
  `
  return rows[0] ? toRow(rows[0]) : null
}

/** `'conflict'` when another request already holds the order's one pending row. */
export async function insertOrderPayment(
  row: Omit<OrderPaymentRow, 'id' | 'paidAt' | 'status'>,
): Promise<OrderPaymentRow | 'conflict'> {
  try {
    const rows = await sql<PaymentDbRow[]>`
      insert into order_payments (order_id, merchant_id, gateway, gateway_request_id, qr_payload, amount, currency, status, expires_at)
      values (${row.orderId}, ${row.merchantId}, ${row.gateway}, ${row.gatewayRequestId}, ${row.qrPayload},
              ${row.amount}, ${row.currency}, 'pending', ${row.expiresAt})
      returning ${PAYMENT_COLUMNS}
    `
    return toRow(rows[0])
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: string }).code === '23505') return 'conflict'
    throw err
  }
}

/**
 * Closes a PENDING row only. A completed payment stays landed, and a row HitPay already reported
 * as failed keeps that status rather than being relabelled expired by our own clock.
 */
export async function closeOrderPayment(id: string, merchantId: string, status: 'expired' | 'failed'): Promise<void> {
  await sql`
    update order_payments set status = ${status}
    where id = ${id} and merchant_id = ${merchantId} and status = 'pending'
  `
}

export type SettleOutcome = 'paid' | 'paid_after_cancel' | 'recorded' | 'already'

/**
 * HitPay said this request is paid. One transaction: lock the payment row, then the order, then
 * decide from the order's status AT THE LOCK. Lock order is payment → order; no other path locks
 * order_payments, so this cannot deadlock against a merchant's order PATCH.
 *
 *   pending_payment → new, `payment_confirmed` + `status_changed` (both by the system)
 *   cancelled       → stays cancelled, `payment_after_cancel` — the shop must refund it
 *   any other       → the merchant moved it already; `payment_confirmed` only
 *   row completed   → nothing: a second signal or poll is safe
 */
export async function settleOrderPayment(
  paymentId: string,
  merchantId: string,
): Promise<{ outcome: SettleOutcome; orderNumber: string }> {
  return withTransaction(async (tx) => {
    const [p] = await tx<{ id: string; order_id: string; status: string; gateway: string; gateway_request_id: string }[]>`
      select id, order_id, status, gateway, gateway_request_id from order_payments
      where id = ${paymentId} and merchant_id = ${merchantId} for update
    `
    if (!p) throw new Error(`order payment ${paymentId} not found for merchant ${merchantId}`)
    const [o] = await tx<{ status: string | null; order_number: string }[]>`
      select status, order_number from orders where id = ${p.order_id} and merchant_id = ${merchantId} for update
    `
    if (!o) throw new Error(`order ${p.order_id} not found for merchant ${merchantId}`)
    if (p.status === 'completed') return { outcome: 'already' as const, orderNumber: o.order_number }

    await tx`update order_payments set status = 'completed', paid_at = now() where id = ${p.id} and merchant_id = ${merchantId}`
    const order = { id: p.order_id, merchantId }
    const detail = { gateway: p.gateway, request_id: p.gateway_request_id }
    const status = o.status ?? 'new'
    if (status === 'pending_payment') {
      await tx`update orders set status = 'new' where id = ${p.order_id} and merchant_id = ${merchantId}`
      await recordOrderEvents(tx, order, SYSTEM_ACTOR, [
        { kind: 'payment_confirmed', detail },
        { kind: 'status_changed', detail: { from: 'pending_payment', to: 'new' } },
      ])
      return { outcome: 'paid' as const, orderNumber: o.order_number }
    }
    if (status === 'cancelled') {
      await recordOrderEvents(tx, order, SYSTEM_ACTOR, [{ kind: 'payment_after_cancel', detail }])
      return { outcome: 'paid_after_cancel' as const, orderNumber: o.order_number }
    }
    await recordOrderEvents(tx, order, SYSTEM_ACTOR, [{ kind: 'payment_confirmed', detail }])
    return { outcome: 'recorded' as const, orderNumber: o.order_number }
  })
}

/**
 * True when the merchant's "new order" alert must wait for the payment: the shop takes HitPay and
 * this order is still unpaid. The alert then goes out from `confirmHitpayPayment`, after the
 * commit, with the paid banner (spec 2026-10-02 → Notifications).
 */
export async function merchantAlertHeld(merchantId: string, orderNumber: string): Promise<boolean> {
  const rows = await sql<{ held: boolean }[]>`
    select (m.hitpay_connected and o.status = 'pending_payment') as held
    from orders o join merchants m on m.id = o.merchant_id
    where o.merchant_id = ${merchantId} and o.order_number = ${orderNumber}
  `
  return rows[0]?.held === true
}
