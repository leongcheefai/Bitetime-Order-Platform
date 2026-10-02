// Support chat — the pure half. See docs/superpowers/specs/2026-10-02-support-chat-design.md.
//
// No env.ts, supabase.ts or db.ts import, so `pnpm test` drives every rule here with no stack.
// The SQL half is supportChatDb.ts; the Bot API adapter is supportTelegram.ts.
import { timingSafeEqual } from 'node:crypto'
import { SUPPORT_MAX_LENGTH } from '@bitetime/shared'
import { plainField } from './platformNotify.js'

/** Telegram's own limit on a forum topic name. */
export const TOPIC_NAME_MAX = 128

/** The away-email rule. supportChatDb.ts passes both into one SQL statement. */
export const AWAY_AFTER_SECONDS = 120
export const AWAY_EMAIL_EVERY_SECONDS = 3600

export const PHOTO_NOTICE = 'Photos do not reach the merchant. Send text.'

/** "<shop name> (<slug>)", cut from the NAME end so the slug — the unique part — survives. */
export function topicName(name: string, slug: string): string {
  const tail = ` (${plainField(slug)})`
  const head = plainField(name).slice(0, Math.max(0, TOPIC_NAME_MAX - tail.length)).trim()
  return `${head}${tail}`
}

/** The first post in a new topic. Plain text: it goes out with no parse_mode. */
export function topicHeader(input: {
  name: string; slug: string; status: string; ownerEmail: string | null; frontendUrl: string
}): string {
  const base = String(input.frontendUrl ?? '').replace(/\/+$/, '')
  return [
    '💬 New support thread',
    '',
    `Shop: ${plainField(input.name)}`,
    `Status: ${plainField(input.status)}`,
    `Owner: ${plainField(input.ownerEmail) || 'unknown'}`,
    '',
    `${base}/s/${plainField(input.slug)}`,
    '',
    'Reply in this topic. Text only — photos do not reach the merchant.',
  ].join('\n')
}

/** The merchant's words, verbatim. Sent with no parse_mode, so no character can break the send. */
export function merchantText(body: string, imageCount: number): string {
  if (imageCount <= 0) return body
  return `${body}\n\n📎 ${imageCount} screenshot${imageCount === 1 ? '' : 's'} below`
}

export type ParsedUpdate =
  | { kind: 'reply'; topicId: number; messageId: number; text: string }
  | { kind: 'photo'; topicId: number }
  | { kind: 'ignore' }

const IGNORE: ParsedUpdate = { kind: 'ignore' }

/**
 * Read one Telegram update. Only `message` counts: an `edited_message` does not change a reply
 * the merchant may already have read. The chat must be the support chat, the sender a human,
 * and the message inside a topic — "General" belongs to no shop.
 */
export function parseUpdate(update: unknown, chatId: string): ParsedUpdate {
  if (!update || typeof update !== 'object') return IGNORE
  const m = (update as { message?: any }).message
  if (!m || typeof m !== 'object') return IGNORE
  if (String(m.chat?.id ?? '') !== String(chatId)) return IGNORE
  if (!m.from || m.from.is_bot !== false) return IGNORE
  const topicId = m.message_thread_id
  if (m.is_topic_message !== true || !Number.isInteger(topicId)) return IGNORE

  if (typeof m.text === 'string' && m.text.trim()) {
    if (!Number.isInteger(m.message_id)) return IGNORE
    return { kind: 'reply', topicId, messageId: m.message_id, text: m.text.trim() }
  }
  if (Array.isArray(m.photo) && m.photo.length > 0) return { kind: 'photo', topicId }
  return IGNORE
}

/** The CHECK allows 2000 characters. A longer reply is cut, not refused: it must still land. */
export function clampReply(text: string): string {
  if (text.length <= SUPPORT_MAX_LENGTH) return text
  return `${text.slice(0, SUPPORT_MAX_LENGTH - 1)}…`
}

/** Constant-time compare. An empty expected secret matches nothing — the route also 503s on it. */
export function secretMatches(given: string, expected: string): boolean {
  if (!expected) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** No reply text in the mail: the dashboard is where the conversation lives. */
export function awayEmail(input: { shopName: string; dashboardUrl: string }): { subject: string; text: string } {
  return {
    subject: 'You have a reply from TinyOrder support',
    text: [
      `Hi ${plainField(input.shopName) || 'there'},`,
      '',
      'The TinyOrder team replied to your support message.',
      `Open your dashboard to read it: ${input.dashboardUrl}`,
      '',
      'The chat bubble at the bottom right shows the conversation.',
    ].join('\n'),
  }
}

/**
 * Telegram refuses getUpdates on a bot with a webhook, and the only way past that is to delete
 * the webhook — which, on the production bot, silently stops every merchant's replies. The poll
 * script therefore refuses outright and names the fix: a separate dev bot.
 */
export function pollRefusal(webhookUrl: string): string | null {
  if (!webhookUrl) return null
  return `This bot has a webhook (${webhookUrl}). Poll mode would have to delete it. Use a separate dev bot in apps/backend/.env.`
}
