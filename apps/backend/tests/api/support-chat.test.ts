// tests/api/support-chat.test.ts
// Support chat, merchant side, driven in-process against the real local Postgres.
//
// The load-bearing assertions are the tenancy ones: `admin` and db.ts are RLS-exempt, so
// requireMerchantOwns is the ONLY thing between a merchant and another shop's thread.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { app, supportDeps, supportWindow } from '../../src/app.js'
import { makeUser, seedMerchant, serviceClient, resetMerchant } from '../rls/helpers.js'
import { TelegramThreadGone, type SupportTelegram } from '../../src/supportTelegram.js'

async function tokenOf(client: Awaited<ReturnType<typeof makeUser>>) {
  const { data } = await client.auth.getSession()
  return { token: data.session!.access_token, userId: data.session!.user.id }
}

const PNG_1X1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
)
const png = (name: string) => new File([PNG_1X1], name, { type: 'image/png' })

function send(merchantId: string, token: string, body: string, files: File[] = []) {
  const form = new FormData()
  form.append('body', body)
  for (const f of files) form.append('images', f)
  return app.request(`/api/merchants/${merchantId}/support/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  })
}
// Response.json() is `unknown` under strict mode; these tests read loose shapes on purpose.
const json = async (r: Response): Promise<any> => r.json()
const get = (path: string, token: string) => app.request(path, { headers: { Authorization: `Bearer ${token}` } })
const postEmpty = (path: string, token: string) =>
  app.request(path, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })

// Topic ids are unique across shops and the tables outlive a run, so start each run somewhere new.
let nextId = 1_000_000 + Math.floor(Math.random() * 1_000_000_000)

function fakeTelegram() {
  const calls = { topics: [] as string[], texts: [] as { topicId: number; text: string }[], photos: [] as number[], reopens: [] as number[] }
  const gone = new Set<number>()
  let failAll = false
  const tg: SupportTelegram = {
    async createTopic(_cfg, name) {
      if (failAll) throw new Error('Telegram down')
      calls.topics.push(name)
      await new Promise(r => setTimeout(r, 50)) // widen the race window for the concurrency test
      return nextId++
    },
    async sendText(_cfg, topicId, text) {
      if (failAll) throw new Error('Telegram down')
      if (gone.has(topicId)) throw new TelegramThreadGone(topicId)
      calls.texts.push({ topicId, text })
      return nextId++
    },
    async sendPhoto(_cfg, topicId) {
      calls.photos.push(topicId)
      return nextId++
    },
    async reopenTopic(_cfg, topicId) {
      calls.reopens.push(topicId)
    },
  }
  return { tg, calls, gone, setFailAll: (v: boolean) => { failAll = v } }
}

describe('support chat — merchant routes', () => {
  let ownerToken: string
  let ownerUserId: string
  let ownShopId: string
  let strangerToken: string
  let strangerShopId: string
  let suspendedToken: string
  let suspendedShopId: string
  let superToken: string
  let fake: ReturnType<typeof fakeTelegram>
  const orig = { ...supportDeps }

  beforeAll(async () => {
    for (const s of ['support-own', 'support-stranger', 'support-suspended', 'support-pending', 'support-race', 'support-cursor']) {
      await resetMerchant(s)
    }
    const owner = await tokenOf(await makeUser('support-owner@example.com', 'password123'))
    ownerToken = owner.token
    ownerUserId = owner.userId
    ownShopId = await seedMerchant({ slug: 'support-own', owner_id: owner.userId, name: 'Own *Shop*' })
    const stranger = await tokenOf(await makeUser('support-stranger@example.com', 'password123'))
    strangerToken = stranger.token
    strangerShopId = await seedMerchant({ slug: 'support-stranger', owner_id: stranger.userId })
    const susp = await tokenOf(await makeUser('support-suspended@example.com', 'password123'))
    suspendedToken = susp.token
    suspendedShopId = await seedMerchant({ slug: 'support-suspended', owner_id: susp.userId, status: 'suspended' })

    const sup = await tokenOf(await makeUser('support-super@example.com', 'password123'))
    const svc = serviceClient()
    await svc.from('profiles').delete().eq('user_id', sup.userId)
    await svc.from('profiles').insert({ user_id: sup.userId, name: 'Super', app_role: 'superadmin' })
    superToken = sup.token
  })

  beforeEach(() => {
    fake = fakeTelegram()
    supportDeps.telegram = fake.tg
    supportDeps.config = { token: 'T', chatId: '-100123', webhookSecret: 'secret' }
  })

  afterAll(() => { Object.assign(supportDeps, orig) })

  it('stores the message, creates one topic with a header, and forwards the text verbatim', async () => {
    const res = await send(ownShopId, ownerToken, '  Joe *Star* 🍰 蛋糕  ')
    expect(res.status).toBe(201)
    const out = await json(res)
    expect(out.alerted).toBe(true)
    expect(out.message).toMatchObject({ sender: 'merchant', body: 'Joe *Star* 🍰 蛋糕', image_count: 0 })
    expect(fake.calls.topics).toEqual(['Own Shop (support-own)'])
    expect(fake.calls.texts).toHaveLength(2) // header, then the message
    expect(fake.calls.texts[0].text).toContain('/s/support-own')
    expect(fake.calls.texts[1].text).toBe('Joe *Star* 🍰 蛋糕')
  })

  it('reuses the topic for the next message, with no second header', async () => {
    const res = await send(ownShopId, ownerToken, 'second message')
    expect(res.status).toBe(201)
    expect(fake.calls.topics).toEqual([])
    expect(fake.calls.texts.map(t => t.text)).toEqual(['second message'])
    expect(fake.calls.reopens).toEqual([]) // the thread was never resolved
  })

  it('reopens a resolved topic when the merchant writes again, and clears resolved_at', async () => {
    const svc = serviceClient()
    await svc.from('support_threads').update({ resolved_at: new Date().toISOString() }).eq('merchant_id', ownShopId)
    const before = await json(await get(`/api/merchants/${ownShopId}/support/messages`, ownerToken))
    expect(before.resolved_at).not.toBeNull()

    const { data } = await svc.from('support_threads').select('tg_topic_id').eq('merchant_id', ownShopId).single()
    expect((await send(ownShopId, ownerToken, 'it broke again')).status).toBe(201)
    expect(fake.calls.reopens).toEqual([Number(data!.tg_topic_id)])
    expect(fake.calls.texts.at(-1)!.text).toBe('it broke again')

    const after = await json(await get(`/api/merchants/${ownShopId}/support/messages`, ownerToken))
    expect(after.resolved_at).toBeNull()
  })

  it('creates exactly one topic when two first messages arrive together', async () => {
    const u = await tokenOf(await makeUser('support-race@example.com', 'password123'))
    const shop = await seedMerchant({ slug: 'support-race', owner_id: u.userId })
    const [a, b] = await Promise.all([send(shop, u.token, 'one'), send(shop, u.token, 'two')])
    expect([a.status, b.status]).toEqual([201, 201])
    expect(fake.calls.topics).toHaveLength(1)
  })

  it('recreates a topic deleted by hand and still delivers', async () => {
    const { data } = await serviceClient().from('support_threads').select('tg_topic_id').eq('merchant_id', ownShopId).single()
    fake.gone.add(Number(data!.tg_topic_id))
    const res = await send(ownShopId, ownerToken, 'after delete')
    expect(res.status).toBe(201)
    expect((await json(res)).alerted).toBe(true)
    expect(fake.calls.topics).toHaveLength(1)
    expect(fake.calls.texts.at(-1)!.text).toBe('after delete')
  })

  it('keeps the message and answers alerted:false when Telegram is down', async () => {
    fake.setFailAll(true)
    const res = await send(ownShopId, ownerToken, 'telegram is down')
    expect(res.status).toBe(201)
    expect((await json(res)).alerted).toBe(false)
    const feed = await json(await get(`/api/merchants/${ownShopId}/support/messages`, ownerToken))
    expect(feed.messages.map((m: any) => m.body)).toContain('telegram is down')
  })

  it('uploads screenshots, forwards them, and serves them only to the owner', async () => {
    const res = await send(ownShopId, ownerToken, 'see screenshots', [png('a.png'), png('b.png')])
    expect(res.status).toBe(201)
    const out = await json(res)
    expect(out.message.image_count).toBe(2)
    expect(out.images_failed).toBe(0)
    expect(fake.calls.photos).toHaveLength(2)

    const own = await get(`/api/merchants/${ownShopId}/support/messages/${out.message.id}/images/0`, ownerToken)
    expect(own.status).toBe(200)
    // The stranger names their OWN shop in the route, with our message id: still a 404.
    const cross = await get(`/api/merchants/${strangerShopId}/support/messages/${out.message.id}/images/0`, strangerToken)
    expect(cross.status).toBe(404)
    const outOfRange = await get(`/api/merchants/${ownShopId}/support/messages/${out.message.id}/images/5`, ownerToken)
    expect(outOfRange.status).toBe(404)
  })

  it('refuses a stranger on every route of another shop', async () => {
    expect((await send(ownShopId, strangerToken, 'hi')).status).toBe(403)
    expect((await get(`/api/merchants/${ownShopId}/support/messages`, strangerToken)).status).toBe(403)
    expect((await postEmpty(`/api/merchants/${ownShopId}/support/read`, strangerToken)).status).toBe(403)
  })

  it('refuses a superadmin write, and a superadmin read does not mark the merchant seen', async () => {
    expect((await send(ownShopId, superToken, 'impersonated')).status).toBe(403)
    expect((await postEmpty(`/api/merchants/${ownShopId}/support/read`, superToken)).status).toBe(403)

    const svc = serviceClient()
    await svc.from('support_threads').update({ merchant_last_seen_at: null }).eq('merchant_id', ownShopId)
    expect((await get(`/api/merchants/${ownShopId}/support/messages`, superToken)).status).toBe(200)
    const { data } = await svc.from('support_threads').select('merchant_last_seen_at').eq('merchant_id', ownShopId).single()
    expect(data!.merchant_last_seen_at).toBeNull()
  })

  it('lets a suspended shop ask for help', async () => {
    expect((await send(suspendedShopId, suspendedToken, 'why am I suspended?')).status).toBe(201)
  })

  it('lets a pending shop ask for help', async () => {
    const u = await tokenOf(await makeUser('support-pending@example.com', 'password123'))
    const shop = await seedMerchant({ slug: 'support-pending', owner_id: u.userId, status: 'pending' })
    expect((await send(shop, u.token, 'my trial did not start')).status).toBe(201)
  })

  it('validates the text and the images', async () => {
    expect((await send(ownShopId, ownerToken, '   ')).status).toBe(400)
    expect((await send(ownShopId, ownerToken, 'a'.repeat(2001))).status).toBe(400)
    const four = [png('1.png'), png('2.png'), png('3.png'), png('4.png')]
    expect((await send(ownShopId, ownerToken, 'too many', four)).status).toBe(400)
  })

  it('answers 503 support_unavailable when the chat is not configured', async () => {
    supportDeps.config = { token: '', chatId: '', webhookSecret: '' }
    const res = await send(ownShopId, ownerToken, 'hello')
    expect(res.status).toBe(503)
    expect((await json(res)).error).toBe('support_unavailable')
    const feed = await json(await get(`/api/merchants/${ownShopId}/support/messages`, ownerToken))
    expect(feed.available).toBe(false)
  })

  // Without the webhook secret no reply can ever come back, so the chat must not pretend to work.
  it('counts a missing webhook secret as unavailable', async () => {
    supportDeps.config = { token: 'T', chatId: '-100123', webhookSecret: '' }
    expect((await send(ownShopId, ownerToken, 'hello')).status).toBe(503)
    const feed = await json(await get(`/api/merchants/${ownShopId}/support/messages`, ownerToken))
    expect(feed.available).toBe(false)
  })

  // Fills the owner's window, so it stays after every other test that posts as the owner.
  it('consults the rate window under the caller id', async () => {
    for (let i = 0; i < 30; i++) supportWindow.allow(ownerUserId)
    expect((await send(ownShopId, ownerToken, 'one too many')).status).toBe(429)
  })

  it('the cursor returns only later messages, and the GET marks the owner seen', async () => {
    const u = await tokenOf(await makeUser('support-cursor@example.com', 'password123'))
    const shop = await seedMerchant({ slug: 'support-cursor', owner_id: u.userId })
    // Two rows inserted in one statement share created_at; the id tie-break must still order them.
    const svc = serviceClient()
    await svc.from('support_threads').insert({ merchant_id: shop })
    await svc.from('support_messages').insert([
      { merchant_id: shop, sender: 'merchant', body: 'first' },
      { merchant_id: shop, sender: 'admin', body: 'second' },
    ])
    const all = await json(await get(`/api/merchants/${shop}/support/messages`, u.token))
    expect(all.messages).toHaveLength(2)
    expect(all.unread).toBe(1)
    const last = all.messages[1].id
    const later = await json(await get(`/api/merchants/${shop}/support/messages?after=${last}`, u.token))
    expect(later.messages).toEqual([])
    const fromFirst = await json(await get(`/api/merchants/${shop}/support/messages?after=${all.messages[0].id}`, u.token))
    expect(fromFirst.messages.map((m: any) => m.id)).toEqual([last])

    expect((await get(`/api/merchants/${shop}/support/messages?after=not-a-uuid`, u.token)).status).toBe(400)

    const { data } = await svc.from('support_threads').select('merchant_last_seen_at').eq('merchant_id', shop).single()
    expect(data!.merchant_last_seen_at).not.toBeNull()

    expect((await postEmpty(`/api/merchants/${shop}/support/read`, u.token)).status).toBe(200)
    const after = await json(await get(`/api/merchants/${shop}/support/messages`, u.token))
    expect(after.unread).toBe(0)
  })
})
