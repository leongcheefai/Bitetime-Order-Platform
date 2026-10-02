import { describe, it, expect } from 'vitest'
import { createSupportTelegram, TelegramThreadGone } from '../../src/supportTelegram.js'

const cfg = { token: 'T0K', chatId: '-100123', webhookSecret: 's' }

function fakeFetch(reply: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = reply(url, init)
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('supportTelegram', () => {
  it('creates a forum topic and returns its thread id', async () => {
    const f = fakeFetch(() => ({ body: { ok: true, result: { message_thread_id: 314, name: 'x' } } }))
    const tg = createSupportTelegram(f.impl)
    expect(await tg.createTopic(cfg, 'Sunny Bakes (sunny-bakes)')).toBe(314)
    expect(f.calls[0].url).toBe('https://api.telegram.org/botT0K/createForumTopic')
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ chat_id: '-100123', name: 'Sunny Bakes (sunny-bakes)' })
  })

  it('sends text without parse_mode, into the topic, and returns the message id', async () => {
    const f = fakeFetch(() => ({ body: { ok: true, result: { message_id: 9 } } }))
    const tg = createSupportTelegram(f.impl)
    expect(await tg.sendText(cfg, 314, 'Joe *Star* 🍰 蛋糕')).toBe(9)
    const body = JSON.parse(String(f.calls[0].init.body))
    expect(body).toEqual({ chat_id: '-100123', message_thread_id: 314, text: 'Joe *Star* 🍰 蛋糕' })
    expect(body).not.toHaveProperty('parse_mode')
  })

  it('sends a photo as multipart into the topic', async () => {
    const f = fakeFetch(() => ({ body: { ok: true, result: { message_id: 10 } } }))
    const tg = createSupportTelegram(f.impl)
    const file = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' })
    expect(await tg.sendPhoto(cfg, 314, file)).toBe(10)
    expect(f.calls[0].url).toBe('https://api.telegram.org/botT0K/sendPhoto')
    const form = f.calls[0].init.body as FormData
    expect(form.get('chat_id')).toBe('-100123')
    expect(form.get('message_thread_id')).toBe('314')
    expect(form.get('photo')).toBeInstanceOf(File)
  })

  it('throws TelegramThreadGone when the topic no longer exists', async () => {
    const f = fakeFetch(() => ({ status: 400, body: { ok: false, description: 'Bad Request: message thread not found' } }))
    const tg = createSupportTelegram(f.impl)
    const err = await tg.sendText(cfg, 314, 'hi').catch(e => e)
    expect(err).toBeInstanceOf(TelegramThreadGone)
    expect(err.topicId).toBe(314)
  })

  it('throws a plain error with the description on any other failure', async () => {
    const f = fakeFetch(() => ({ status: 403, body: { ok: false, description: 'Forbidden: bot is not a member' } }))
    const tg = createSupportTelegram(f.impl)
    const err = await tg.createTopic(cfg, 'x').catch(e => e)
    expect(err).not.toBeInstanceOf(TelegramThreadGone)
    expect(String(err.message)).toContain('bot is not a member')
  })
})
