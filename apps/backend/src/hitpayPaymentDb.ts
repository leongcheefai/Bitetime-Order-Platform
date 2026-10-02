// The HitPay flow's SQL (spec 2026-10-02). `db.ts` is RLS-EXEMPT, so every statement here names
// the merchant it acts for: on this path, which shop a row belongs to is a TypeScript rule, not a
// Postgres one. The pure half is hitpayPayment.ts.
import { sql, withTransaction } from './db.js'

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
