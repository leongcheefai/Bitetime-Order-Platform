// tests/api/support-webhook.test.ts
// The superadmin's replies, arriving from Telegram. Real Postgres: the dedupe and the away-email
// claim are SQL properties, and a mocked database would prove neither.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { app, supportDeps } from '../../src/app.js'
import { makeUser, seedMerchant, serviceClient, resetMerchant } from '../rls/helpers.js'
import type { SupportTelegram } from '../../src/supportTelegram.js'

const CHAT = '-1009876543210'
const SECRET = 'webhook-secret'
let nextId = 2_000_000_000 + Math.floor(Math.random() * 100_000_000)

function hook(update: unknown, secret = SECRET) {
  return app.request('/api/telegram/support-webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify(update),
  })
}

function reply(topicId: number, text: string, messageId = nextId++) {
  return {
    update_id: nextId++,
    message: {
      message_id: messageId, chat: { id: Number(CHAT), type: 'supergroup' },
      from: { id: 1, is_bot: false }, message_thread_id: topicId, is_topic_message: true, text,
    } as Record<string, any>,
  }
}

describe('support webhook', () => {
  let shopId: string
  let topicId: number
  const ownerEmail = 'support-hook-owner@example.com'
  const sentTexts: { topicId: number; text: string }[] = []
  const emails: { to: string; subject: string }[] = []
  const orig = { ...supportDeps }
  const svc = serviceClient()

  async function setThread(fields: Record<string, unknown>) {
    const { error } = await svc.from('support_threads').update(fields).eq('merchant_id', shopId)
    if (error) throw new Error(error.message)
  }
  const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()

  beforeAll(async () => {
    await resetMerchant('support-hook')
    const owner = await makeUser(ownerEmail, 'password123')
    const { data } = await owner.auth.getSession()
    shopId = await seedMerchant({ slug: 'support-hook', owner_id: data.session!.user.id, name: 'Hook Shop' })
    topicId = nextId++
    const { error } = await svc.from('support_threads').insert({ merchant_id: shopId, tg_topic_id: topicId })
    if (error) throw new Error(error.message)
  })

  beforeEach(async () => {
    sentTexts.length = 0
    emails.length = 0
    const tg: SupportTelegram = {
      async createTopic() { throw new Error('not expected') },
      async sendText(_c, t, text) { sentTexts.push({ topicId: t, text }); return nextId++ },
      async sendPhoto() { return nextId++ },
    }
    supportDeps.telegram = tg
    supportDeps.email = async (to, subject) => { emails.push({ to, subject }) }
    supportDeps.config = { token: 'T', chatId: CHAT, webhookSecret: SECRET }
    // Default: the merchant is on the dashboard right now, and no email went out recently.
    await setThread({ merchant_last_seen_at: new Date().toISOString(), last_away_email_at: null })
  })

  afterAll(() => { Object.assign(supportDeps, orig) })

  async function adminBodies() {
    const { data } = await svc.from('support_messages').select('body').eq('merchant_id', shopId).eq('sender', 'admin')
    return (data ?? []).map(r => r.body as string)
  }

  it('refuses a wrong secret with 401 and stores nothing', async () => {
    const res = await hook(reply(topicId, 'should not land'), 'wrong')
    expect(res.status).toBe(401)
    expect(await adminBodies()).not.toContain('should not land')
  })

  it('answers 503 when the webhook secret is not configured', async () => {
    supportDeps.config = { token: 'T', chatId: CHAT, webhookSecret: '' }
    expect((await hook(reply(topicId, 'x'), '')).status).toBe(503)
  })

  it('stores a text reply in the topic for that shop', async () => {
    const res = await hook(reply(topicId, 'Hi! Please try again.'))
    expect(res.status).toBe(200)
    expect(await adminBodies()).toContain('Hi! Please try again.')
  })

  it('stores a repeated update once', async () => {
    const u = reply(topicId, 'only once please')
    expect((await hook(u)).status).toBe(200)
    expect((await hook(u)).status).toBe(200)
    expect((await adminBodies()).filter(b => b === 'only once please')).toHaveLength(1)
  })

  it('ignores an unknown topic, another chat and a bot sender, with 200', async () => {
    expect((await hook(reply(nextId++, 'nobody owns this topic'))).status).toBe(200)
    const other = reply(topicId, 'other chat'); other.message.chat = { id: -100111, type: 'supergroup' }
    expect((await hook(other)).status).toBe(200)
    const bot = reply(topicId, 'from a bot'); bot.message.from = { id: 9, is_bot: true }
    expect((await hook(bot)).status).toBe(200)
    const bodies = await adminBodies()
    expect(bodies).not.toContain('nobody owns this topic')
    expect(bodies).not.toContain('other chat')
    expect(bodies).not.toContain('from a bot')
  })

  it('answers a photo with a notice in the same topic', async () => {
    const u = reply(topicId, 'x')
    delete u.message.text
    u.message.photo = [{ file_id: 'abc' }]
    expect((await hook(u)).status).toBe(200)
    expect(sentTexts).toEqual([{ topicId, text: 'Photos do not reach the merchant. Send text.' }])
  })

  it('cuts a long reply to 2000 characters', async () => {
    await hook(reply(topicId, 'L'.repeat(2500)))
    const long = (await adminBodies()).find(b => b.startsWith('LLLL'))!
    expect(long).toHaveLength(2000)
  })

  it('sends no email while the merchant is on the dashboard', async () => {
    await setThread({ merchant_last_seen_at: ago(60) })
    await hook(reply(topicId, 'merchant is here'))
    expect(emails).toEqual([])
  })

  it('emails the owner once when the merchant is away, and not again within the hour', async () => {
    await setThread({ merchant_last_seen_at: ago(180) })
    await hook(reply(topicId, 'away one'))
    await hook(reply(topicId, 'away two'))
    expect(emails).toHaveLength(1)
    expect(emails[0].to).toBe(ownerEmail)
  })

  it('emails again after the hour has passed', async () => {
    await setThread({ merchant_last_seen_at: ago(7200), last_away_email_at: ago(3700) })
    await hook(reply(topicId, 'an hour later'))
    expect(emails).toHaveLength(1)
  })

  it('sends one email when two replies arrive together', async () => {
    await setThread({ merchant_last_seen_at: ago(600), last_away_email_at: null })
    await Promise.all([hook(reply(topicId, 'together a')), hook(reply(topicId, 'together b'))])
    expect(emails).toHaveLength(1)
  })
})
