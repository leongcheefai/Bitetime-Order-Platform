// tests/unit/platformNotify.test.ts
// The PLATFORM's Telegram arm — the superadmin's own chat, not a merchant's.
//
// Pure builder plus one send, so this suite needs no env, no Supabase and no network. The
// properties it holds are the two that decide whether the alert is worth having: the message
// says which shop and whether that shop is open for business, and a shop name can never break
// the send.
import { describe, it, expect } from 'vitest'
import { buildMerchantSignupMessage, notifyMerchantSignup, type MerchantSignupInput } from '../../src/platformNotify.js'
import type { TelegramSend } from '../../src/notify.js'

const INPUT: MerchantSignupInput = {
  merchant: {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Joe Coffee',
    slug: 'joe-coffee',
    status: 'active',
  },
  ownerEmail: 'joe@example.com',
  trial: true,
  frontendUrl: 'https://tinyorder.vercel.app',
}

describe('buildMerchantSignupMessage', () => {
  it('names the shop, its slug and its owner', () => {
    const msg = buildMerchantSignupMessage(INPUT)
    expect(msg).toContain('New merchant')
    expect(msg).toContain('Joe Coffee')
    expect(msg).toContain('joe-coffee')
    expect(msg).toContain('joe@example.com')
  })

  // The alert is a ping, not a record. The trade, the currency and the billing cycle are all one
  // tap away on the shop the link opens, and every line here competes with the status line.
  it('carries nothing else about the shop', () => {
    const msg = buildMerchantSignupMessage(INPUT)
    expect(msg).not.toContain('Trade')
    expect(msg).not.toContain('Currency')
    expect(msg).not.toContain('Billing')
  })

  it('reports an active shop as open with its trial running', () => {
    const msg = buildMerchantSignupMessage(INPUT)
    expect(msg).toContain('active — trial started')
  })

  // The other half of the contract, and the reason the message is sent at all: a shop parked at
  // `pending` is a shop Stripe refused, and nobody learns of it unless someone opens /admin.
  it('reports a pending shop as provisioning that failed', () => {
    const msg = buildMerchantSignupMessage({
      ...INPUT,
      merchant: { ...INPUT.merchant, status: 'pending' },
      trial: false,
    })
    expect(msg).toContain('pending')
    expect(msg).toContain('trial not started')
  })

  it('links the storefront', () => {
    const msg = buildMerchantSignupMessage(INPUT)
    expect(msg).toContain('https://tinyorder.vercel.app/s/joe-coffee')
  })

  it('says so when the owner email is missing rather than printing an empty label', () => {
    const msg = buildMerchantSignupMessage({ ...INPUT, ownerEmail: null })
    expect(msg).toContain('unknown')
    expect(msg).not.toMatch(/Owner:\s*\n/)
  })

  // The send goes out as Markdown, so a lone `*` or `_` in a merchant-chosen name is a 400 that
  // costs the whole alert. The name is stripped of the markers rather than escaped: Telegram's
  // legacy Markdown does not document backslash escapes, and losing a `*` from a shop name costs
  // the superadmin nothing.
  it('strips Markdown markers out of a merchant-chosen name', () => {
    const msg = buildMerchantSignupMessage({
      ...INPUT,
      merchant: { ...INPUT.merchant, name: 'Joe *Star* _Coffee_ [x] `y`' },
    })
    expect(msg).toContain('Joe Star Coffee x y')
    // What actually reaches Telegram: every `*` left in the text is one this module wrote as a
    // label marker, so their count is even and the parse cannot fail.
    expect((msg.match(/\*/g) ?? []).length % 2).toBe(0)
    expect(msg).not.toContain('_')
    expect(msg).not.toContain('`')
  })

  it('clamps a very long shop name so the message cannot approach the Telegram ceiling', () => {
    const msg = buildMerchantSignupMessage({
      ...INPUT,
      merchant: { ...INPUT.merchant, name: 'a'.repeat(500) },
    })
    expect(msg.length).toBeLessThan(1000)
  })
})

describe('notifyMerchantSignup', () => {
  // A recording adapter rather than a mock: it holds the real TelegramSend signature, so the
  // assertions below are about what would reach the Bot API, not about a spy.
  function recorder() {
    const sent: Array<[string, string, string]> = []
    const send: TelegramSend = async (token, chatId, text) => { sent.push([token, chatId, text]) }
    return { sent, send }
  }

  it('sends to the configured platform chat', async () => {
    const { sent, send } = recorder()
    const res = await notifyMerchantSignup(send, { token: 'tok', chatId: '-100123' }, INPUT)
    expect(res).toEqual({ ok: true })
    expect(sent).toHaveLength(1)
    expect(sent[0][0]).toBe('tok')
    expect(sent[0][1]).toBe('-100123')
    expect(sent[0][2]).toContain('joe-coffee')
  })

  // Unset config is the ordinary state of a dev machine and of any deployment that has not set
  // the pair. It is a skip, never an error and never a throw — the signup already succeeded.
  it('skips without a token', async () => {
    const { sent, send } = recorder()
    const res = await notifyMerchantSignup(send, { token: '', chatId: '-100123' }, INPUT)
    expect(res).toEqual({ ok: true, skipped: true })
    expect(sent).toHaveLength(0)
  })

  it('skips without a chat id', async () => {
    const { sent, send } = recorder()
    const res = await notifyMerchantSignup(send, { token: 'tok', chatId: '' }, INPUT)
    expect(res).toEqual({ ok: true, skipped: true })
    expect(sent).toHaveLength(0)
  })

  it('reports a failed send without throwing', async () => {
    const send: TelegramSend = async () => { throw new Error('Telegram sendMessage failed: 400') }
    const res = await notifyMerchantSignup(send, { token: 'tok', chatId: '-100123' }, INPUT)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('400')
  })
})
