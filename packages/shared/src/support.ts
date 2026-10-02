// Support chat (docs/superpowers/specs/2026-10-02-support-chat-design.md). The message bound is
// duplicated in the support_messages CHECK, which is the authority; this copy exists so the
// panel can refuse before the merchant loses a message to a 400. Images reuse the feedback
// image rules (validateFeedbackImages), which are the same three types and the same 5 MiB.

export const SUPPORT_MAX_LENGTH = 2000

export type SupportSender = 'merchant' | 'admin'

export interface SupportMessage {
  id: string
  sender: SupportSender
  body: string
  image_count: number
  created_at: string
}

export interface SupportFeed {
  messages: SupportMessage[]
  unread: number
  /** False when the platform has no support chat configured. The panel then shows mail/WhatsApp. */
  available: boolean
}

export interface SupportSendResult {
  message: SupportMessage
  /** False when the row is stored but Telegram did not take it. */
  alerted: boolean
  images_failed: number
}

export type SupportMessageValidation =
  | { ok: true; value: string }
  | { ok: false; code: 'empty' | 'too_long'; error: string }

export function validateSupportMessage(body: unknown): SupportMessageValidation {
  const text = typeof body === 'string' ? body.trim() : ''
  if (!text) return { ok: false, code: 'empty', error: 'Message is empty' }
  if (text.length > SUPPORT_MAX_LENGTH) {
    return { ok: false, code: 'too_long', error: `Message is longer than ${SUPPORT_MAX_LENGTH} characters` }
  }
  return { ok: true, value: text }
}
