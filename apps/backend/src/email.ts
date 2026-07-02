// Server-side email via Resend's REST API — plain fetch, no SDK (mirrors the
// telegramSend adapter in notify.ts). Injected into handlers for testability.
import { env } from './env.js'

export type EmailSend = (to: string, subject: string, text: string) => Promise<void>

export const resendSend: EmailSend = async (to, subject, text) => {
  if (!env.resendApiKey) {
    console.warn(`RESEND_API_KEY unset — skipping email "${subject}" to ${to}`)
    return
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.resendApiKey}` },
    body: JSON.stringify({ from: env.emailFrom, to: [to], subject, text }),
  })
  if (!res.ok) throw new Error(`Resend send failed: ${res.status}`)
}
