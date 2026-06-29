// Order notifications — the seam between order intake and the outside world
// (Telegram, EmailJS). The transport is injected so the dispatch logic (which
// channels fire, and collecting per-channel outcomes instead of swallowing
// errors) is testable without a network. liveTransport is the real adapter.
import emailjs from '@emailjs/browser'

export interface NotifyTransport {
  sendTelegram(token: string, chatId: string, text: string): Promise<void>
  sendEmail(serviceId: string, templateId: string, params: Record<string, any>, publicKey: string): Promise<void>
}

export type NotifyChannel = 'telegram' | 'email'
export interface NotifyResult { channel: NotifyChannel; ok: boolean; error?: string }

export interface TelegramCfg { token?: string; chatId?: string }
export interface EmailCfg { serviceId?: string; publicKey?: string }
export interface NotifyConfig { telegram?: TelegramCfg; email?: EmailCfg }

export interface OrderPlacedNotice {
  telegram?: { text: string }
  email?: { templateId: string; params: Record<string, any> }
}
export interface OrderShippedNotice {
  email?: { templateId: string; params: Record<string, any> }
}

async function attempt(channel: NotifyChannel, fn: () => Promise<void>): Promise<NotifyResult> {
  try {
    await fn()
    return { channel, ok: true }
  } catch (e: any) {
    return { channel, ok: false, error: e?.message ?? String(e) }
  }
}

// A channel fires only when its credentials AND its payload are both present.
export async function notifyOrderPlaced(
  transport: NotifyTransport, cfg: NotifyConfig, notice: OrderPlacedNotice,
): Promise<NotifyResult[]> {
  const results: NotifyResult[] = []
  if (cfg.telegram?.token && cfg.telegram?.chatId && notice.telegram) {
    results.push(await attempt('telegram', () =>
      transport.sendTelegram(cfg.telegram!.token!, cfg.telegram!.chatId!, notice.telegram!.text)))
  }
  if (cfg.email?.serviceId && cfg.email?.publicKey && notice.email) {
    results.push(await attempt('email', () =>
      transport.sendEmail(cfg.email!.serviceId!, notice.email!.templateId, notice.email!.params, cfg.email!.publicKey!)))
  }
  return results
}

export async function notifyOrderShipped(
  transport: NotifyTransport, cfg: NotifyConfig, notice: OrderShippedNotice,
): Promise<NotifyResult[]> {
  const results: NotifyResult[] = []
  if (cfg.email?.serviceId && cfg.email?.publicKey && notice.email) {
    results.push(await attempt('email', () =>
      transport.sendEmail(cfg.email!.serviceId!, notice.email!.templateId, notice.email!.params, cfg.email!.publicKey!)))
  }
  return results
}

// Real adapter: Telegram Bot API over fetch, EmailJS over its SDK.
export const liveTransport: NotifyTransport = {
  async sendTelegram(token, chatId, text) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    })
    if (!res.ok) throw new Error(`Telegram sendMessage failed: ${res.status}`)
  },
  async sendEmail(serviceId, templateId, params, publicKey) {
    await emailjs.send(serviceId, templateId, params, publicKey)
  },
}
