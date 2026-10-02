import { describe, it, expect } from 'vitest'
import {
  topicName, topicHeader, merchantText, parseUpdate, clampReply, secretMatches, awayEmail,
  pollRefusal, TOPIC_NAME_MAX,
} from '../../src/supportChat.js'

const CHAT = '-1001234567890'

function update(message: Record<string, unknown>) {
  return {
    update_id: 1,
    message: {
      message_id: 77,
      chat: { id: Number(CHAT), type: 'supergroup' },
      from: { id: 5, is_bot: false },
      message_thread_id: 42,
      is_topic_message: true,
      ...message,
    },
  }
}

describe('topicName', () => {
  it('names the topic after the shop and its slug', () => {
    expect(topicName('Sunny Bakes', 'sunny-bakes')).toBe('Sunny Bakes (sunny-bakes)')
  })
  it('strips Markdown markers and stays within the Telegram limit', () => {
    const name = topicName('*Joe* '.repeat(60), 'joe')
    expect(name).not.toMatch(/[*_`[\]]/)
    expect(name.length).toBeLessThanOrEqual(TOPIC_NAME_MAX)
    expect(name.endsWith('(joe)')).toBe(true)
  })
})

describe('topicHeader', () => {
  it('carries the shop link, status and owner email', () => {
    const text = topicHeader({
      name: 'Sunny Bakes', slug: 'sunny-bakes', status: 'active',
      ownerEmail: 'owner@example.com', frontendUrl: 'https://tinyorder.shop/',
    })
    expect(text).toContain('https://tinyorder.shop/s/sunny-bakes')
    expect(text).toContain('active')
    expect(text).toContain('owner@example.com')
  })
  it('says unknown when the owner email is missing', () => {
    const text = topicHeader({ name: 'A', slug: 'a', status: 'pending', ownerEmail: null, frontendUrl: 'x' })
    expect(text).toContain('unknown')
  })
})

describe('merchantText', () => {
  it('keeps the body exactly as typed', () => {
    expect(merchantText('Joe *Star* 🍰 蛋糕', 0)).toBe('Joe *Star* 🍰 蛋糕')
  })
  it('notes how many screenshots follow', () => {
    expect(merchantText('see this', 2)).toBe('see this\n\n📎 2 screenshots below')
    expect(merchantText('see this', 1)).toBe('see this\n\n📎 1 screenshot below')
  })
})

describe('parseUpdate', () => {
  it('accepts a human text reply in a topic of the support chat', () => {
    expect(parseUpdate(update({ text: 'Hi! Please try again.' }), CHAT))
      .toEqual({ kind: 'reply', topicId: 42, messageId: 77, text: 'Hi! Please try again.' })
  })
  it('ignores another chat', () => {
    expect(parseUpdate(update({ text: 'x', chat: { id: -100999, type: 'supergroup' } }), CHAT)).toEqual({ kind: 'ignore' })
  })
  it('ignores a bot sender', () => {
    expect(parseUpdate(update({ text: 'x', from: { id: 9, is_bot: true } }), CHAT)).toEqual({ kind: 'ignore' })
  })
  it('ignores a message in General (no topic)', () => {
    expect(parseUpdate(update({ text: 'x', message_thread_id: undefined, is_topic_message: undefined }), CHAT))
      .toEqual({ kind: 'ignore' })
  })
  it('reports a photo so the bot can say photos do not reach the merchant', () => {
    expect(parseUpdate(update({ photo: [{ file_id: 'f' }] }), CHAT)).toEqual({ kind: 'photo', topicId: 42 })
  })
  it('ignores a service message such as forum_topic_created', () => {
    expect(parseUpdate(update({ forum_topic_created: { name: 'x' } }), CHAT)).toEqual({ kind: 'ignore' })
  })
  it('ignores an edited message and garbage', () => {
    expect(parseUpdate({ update_id: 2, edited_message: update({ text: 'x' }).message }, CHAT)).toEqual({ kind: 'ignore' })
    expect(parseUpdate(null, CHAT)).toEqual({ kind: 'ignore' })
    expect(parseUpdate('nope', CHAT)).toEqual({ kind: 'ignore' })
  })
  it('ignores whitespace-only text', () => {
    expect(parseUpdate(update({ text: '   ' }), CHAT)).toEqual({ kind: 'ignore' })
  })
})

describe('clampReply', () => {
  it('keeps a reply within the limit unchanged', () => {
    expect(clampReply('short')).toBe('short')
    expect(clampReply('a'.repeat(2000))).toHaveLength(2000)
  })
  it('cuts a longer reply to 2000 characters ending in an ellipsis', () => {
    const out = clampReply('a'.repeat(2500))
    expect(out).toHaveLength(2000)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('secretMatches', () => {
  it('matches only the exact secret', () => {
    expect(secretMatches('s3cret', 's3cret')).toBe(true)
    expect(secretMatches('s3cre', 's3cret')).toBe(false)
    expect(secretMatches('', 's3cret')).toBe(false)
  })
  it('never matches when the expected secret is empty', () => {
    expect(secretMatches('', '')).toBe(false)
  })
})

describe('awayEmail', () => {
  it('links to the dashboard and does not need the reply text', () => {
    const mail = awayEmail({ shopName: 'Sunny Bakes', dashboardUrl: 'https://tinyorder.shop/merchant' })
    expect(mail.subject).toContain('reply')
    expect(mail.text).toContain('https://tinyorder.shop/merchant')
    expect(mail.text).toContain('Sunny Bakes')
  })
})

describe('pollRefusal', () => {
  it('refuses poll mode when the bot has a webhook', () => {
    expect(pollRefusal('https://api.example.com/api/telegram/support-webhook')).toMatch(/webhook/i)
  })
  it('allows poll mode when the bot has no webhook', () => {
    expect(pollRefusal('')).toBeNull()
  })
})
