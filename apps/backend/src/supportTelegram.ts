// The support chat's Bot API calls. Separate from notify.ts's telegramSend, which always sends
// Markdown into a plain chat: this one sends into forum TOPICS and never sets parse_mode,
// because the text is a merchant's free text and one stray `*` would make Telegram refuse it.
//
// Token and chat id are parameters, never read from env.ts — the same posture as the Claude
// adapters — so a unit test drives it with a fake fetch.

export interface SupportConfig {
  token: string
  chatId: string
  webhookSecret: string
}

/** The topic was deleted by hand. supportDelivery.ts clears it and makes a new one. */
export class TelegramThreadGone extends Error {
  constructor(public topicId: number) {
    super(`Telegram topic ${topicId} not found`)
  }
}

export interface SupportTelegram {
  createTopic(cfg: SupportConfig, name: string): Promise<number>
  sendText(cfg: SupportConfig, topicId: number, text: string): Promise<number>
  sendPhoto(cfg: SupportConfig, topicId: number, photo: File): Promise<number>
  /** Undo the superadmin's "Close topic" when the merchant writes again. Already open is fine. */
  reopenTopic(cfg: SupportConfig, topicId: number): Promise<void>
}

export function createSupportTelegram(fetchImpl: typeof fetch = fetch): SupportTelegram {
  async function call(cfg: SupportConfig, method: string, body: string | FormData, json: boolean, topicId?: number) {
    const res = await fetchImpl(`https://api.telegram.org/bot${cfg.token}/${method}`, {
      method: 'POST',
      headers: json ? { 'Content-Type': 'application/json' } : undefined,
      body,
    })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: any; description?: string }
    if (res.ok && data.ok) return data.result
    const description = data.description ?? `HTTP ${res.status}`
    if (topicId !== undefined && /thread not found/i.test(description)) throw new TelegramThreadGone(topicId)
    throw new Error(`Telegram ${method} failed: ${description}`)
  }

  return {
    async createTopic(cfg, name) {
      const r = await call(cfg, 'createForumTopic', JSON.stringify({ chat_id: cfg.chatId, name }), true)
      return Number(r.message_thread_id)
    },
    async sendText(cfg, topicId, text) {
      const body = JSON.stringify({ chat_id: cfg.chatId, message_thread_id: topicId, text })
      const r = await call(cfg, 'sendMessage', body, true, topicId)
      return Number(r.message_id)
    },
    async sendPhoto(cfg, topicId, photo) {
      const form = new FormData()
      form.append('chat_id', cfg.chatId)
      form.append('message_thread_id', String(topicId))
      form.append('photo', photo, photo.name)
      const r = await call(cfg, 'sendPhoto', form, false, topicId)
      return Number(r.message_id)
    },
    async reopenTopic(cfg, topicId) {
      const body = JSON.stringify({ chat_id: cfg.chatId, message_thread_id: topicId })
      try {
        await call(cfg, 'reopenForumTopic', body, true, topicId)
      } catch (e) {
        // The topic is open already — someone reopened it by hand. That is the state we wanted.
        if (e instanceof Error && /TOPIC_NOT_MODIFIED/.test(e.message)) return
        throw e
      }
    },
  }
}
