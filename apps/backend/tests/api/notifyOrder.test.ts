// tests/api/notifyOrder.test.ts
// POST /api/notify/order — the post-commit notification fan-out, driven in-process
// against real Postgres via app.request().
//
// The two properties this suite exists to prove cannot be faked and are only real
// against Postgres:
//
//   * ONE-SHOT — confirmation_emailed_at is an atomic null→now() claim. A second
//     call for the same order sends NO second email. A mocked DB would report green
//     while proving nothing about the row lock.
//   * RECIPIENT FROM THE ACCOUNT — the address is read from the order's user_id via
//     Auth, never from the request body. A guest order (user_id null) is excluded
//     structurally, not by a droppable conditional.
//
// Only the outbound adapters are faked (via the exported `notifyDeps` seam) so no
// live email/Telegram network is touched; the database is never mocked.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { app, notifyDeps } from '../../src/app.js'
import { makeUser, resetMerchant, seedMerchant, seedProduct, serviceClient } from '../rls/helpers.js'
import { todayInZone, DEFAULT_TIMEZONE } from '@bitetime/shared'

const SLUG = 'notify-shop'
const CUSTOMER_EMAIL = 'notify-customer@test.dev'

const svc = () => serviceClient()

/** A date the default fulfilment config is certainly taking: today + 1, on the shop's clock. */
function tomorrowInShopZone(): string {
  const today = todayInZone(DEFAULT_TIMEZONE, new Date())
  const d = new Date(`${today}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

function orderBody(merchantId: string, productId: string, extra: Record<string, unknown> = {}) {
  return {
    merchantId,
    customerName: 'Ah Meng',
    customerWa: '60123456789',
    mode: 'pickup',
    cart: { [productId]: 2 },
    quotedTotal: 26,
    fulfilDate: tomorrowInShopZone(),
    ...extra,
  }
}

function postOrder(payload: unknown, token?: string) {
  return app.request('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  })
}

function postNotify(payload: unknown) {
  return app.request('/api/notify/order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

async function placeOrderReturningNumber(payload: unknown, token?: string): Promise<string> {
  const res = await postOrder(payload, token)
  const json = (await res.json()) as { orderNumber?: string; error?: string }
  if (!json.orderNumber) throw new Error(`order intake failed: ${json.error ?? res.status}`)
  return json.orderNumber
}

// Captured outbound mail. The Telegram adapter is a no-op success unless a test
// overrides it. Both are restored after the suite.
type Sent = { to: string; subject: string; body: { text: string; html?: string; from?: string } }
let sentEmails: Sent[]
const origEmail = notifyDeps.email
const origTelegram = notifyDeps.telegram

let merchantId: string
let productId: string
let customerToken: string

describe('POST /api/notify/order — customer confirmation email fan-out', () => {
  beforeAll(async () => {
    const owner = await makeUser('notify-owner@test.dev', 'password123')
    const ownerId = (await owner.auth.getUser()).data.user!.id
    merchantId = await seedMerchant({ slug: SLUG, owner_id: ownerId, name: 'Notify Shop', plan: 'pro' })
    productId = await seedProduct({ merchant_id: merchantId, price: 13 })

    const customer = await makeUser(CUSTOMER_EMAIL, 'password123')
    customerToken = (await customer.auth.getSession()).data.session!.access_token
  })

  afterAll(async () => {
    notifyDeps.email = origEmail
    notifyDeps.telegram = origTelegram
    await resetMerchant(SLUG)
  })

  beforeEach(() => {
    sentEmails = []
    notifyDeps.email = async (to, subject, body) => { sentEmails.push({ to, subject, body }) }
    notifyDeps.telegram = async () => {} // no-op success (a Telegram secret is seeded below per-test)
  })

  it('sends exactly one email, to the account address, for a signed-in customer', async () => {
    const orderNumber = await placeOrderReturningNumber(orderBody(merchantId, productId), customerToken)

    const res = await postNotify({ merchantId, orderNumber, lang: 'en' })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { email: { ok: boolean } }
    expect(json.email.ok).toBe(true)

    expect(sentEmails).toHaveLength(1)
    expect(sentEmails[0].to).toBe(CUSTOMER_EMAIL)
    expect(sentEmails[0].subject).toContain(orderNumber)
    expect(sentEmails[0].body.html).toBeTruthy()
    expect(sentEmails[0].body.from).toContain('Notify Shop')
  })

  it('sends NO email for a guest order (user_id null), and does not error', async () => {
    const orderNumber = await placeOrderReturningNumber(orderBody(merchantId, productId)) // no token ⇒ guest

    const res = await postNotify({ merchantId, orderNumber, lang: 'en' })
    const json = (await res.json()) as { email: { ok: boolean; skipped?: boolean } }
    expect(json.email.ok).toBe(true)
    expect(json.email.skipped).toBe(true)
    expect(sentEmails).toHaveLength(0)
  })

  it('sends at most one email across repeated calls (dedup via confirmation_emailed_at)', async () => {
    const orderNumber = await placeOrderReturningNumber(orderBody(merchantId, productId), customerToken)

    await postNotify({ merchantId, orderNumber, lang: 'en' })
    const second = await postNotify({ merchantId, orderNumber, lang: 'en' })
    const json = (await second.json()) as { email: { ok: boolean; skipped?: boolean } }
    expect(json.email.skipped).toBe(true)
    expect(sentEmails).toHaveLength(1)
  })

  it('never takes the recipient from the request body', async () => {
    const orderNumber = await placeOrderReturningNumber(orderBody(merchantId, productId), customerToken)

    await postNotify({ merchantId, orderNumber, lang: 'en', email: 'attacker@evil.com', to: 'attacker@evil.com' })
    expect(sentEmails).toHaveLength(1)
    expect(sentEmails[0].to).toBe(CUSTOMER_EMAIL)
  })

  it('a Telegram failure does not suppress the customer email', async () => {
    // Seed a Telegram secret so notifyOrderPlaced actually attempts a send, then make it throw.
    await svc().from('merchant_secrets').upsert({ merchant_id: merchantId, tg_token: 't0ken', tg_chat_id: '42' })
    notifyDeps.telegram = async () => { throw new Error('telegram down') }

    const orderNumber = await placeOrderReturningNumber(orderBody(merchantId, productId), customerToken)
    const res = await postNotify({ merchantId, orderNumber, lang: 'en' })
    const json = (await res.json()) as { telegram: { ok: boolean }; email: { ok: boolean } }

    expect(json.telegram.ok).toBe(false)
    expect(json.email.ok).toBe(true)
    expect(sentEmails).toHaveLength(1)

    await svc().from('merchant_secrets').delete().eq('merchant_id', merchantId)
  })

  it('an email failure does not suppress the merchant Telegram', async () => {
    await svc().from('merchant_secrets').upsert({ merchant_id: merchantId, tg_token: 't0ken', tg_chat_id: '42' })
    let telegramSent = 0
    notifyDeps.telegram = async () => { telegramSent++ }
    notifyDeps.email = async () => { throw new Error('resend down') }

    const orderNumber = await placeOrderReturningNumber(orderBody(merchantId, productId), customerToken)
    const res = await postNotify({ merchantId, orderNumber, lang: 'en' })
    const json = (await res.json()) as { telegram: { ok: boolean }; email: { ok: boolean } }

    expect(json.telegram.ok).toBe(true)
    expect(telegramSent).toBe(1)
    expect(json.email.ok).toBe(false)

    await svc().from('merchant_secrets').delete().eq('merchant_id', merchantId)
  })
})
