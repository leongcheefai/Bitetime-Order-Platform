// Server-side email via Resend's REST API — plain fetch, no SDK (mirrors the
// telegramSend adapter in notify.ts). Injected into handlers for testability.
import { env } from './env.js'

// The body carries the text part (always) plus two optionals: `html` for a
// multipart HTML alternative (order confirmations send both; the text-only
// trial mail omits it), and `from` to override the platform default sender —
// the order confirmation puts the shop's name in front of the platform address.
export interface EmailBody {
  text: string
  html?: string
  from?: string
}

export type EmailSend = (to: string, subject: string, body: EmailBody) => Promise<void>

export const resendSend: EmailSend = async (to, subject, { text, html, from }) => {
  if (!env.resendApiKey) {
    console.warn(`RESEND_API_KEY unset — skipping email "${subject}" to ${to}`)
    return
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.resendApiKey}` },
    body: JSON.stringify({
      from: from ?? env.emailFrom,
      to: [to],
      subject,
      text,
      ...(html ? { html } : {}),
    }),
  })
  if (!res.ok) throw new Error(`Resend send failed: ${res.status}`)
}
